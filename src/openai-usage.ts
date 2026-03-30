import { EnvHttpProxyAgent } from "undici";
import type { Store } from "./db.js";
import type {
  CodexUsageWindow,
  ManagedAccount,
  ManagedAccountUsageSnapshot,
} from "./types.js";

const envProxyAgent =
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
    ? new EnvHttpProxyAgent()
    : null;

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_TEST_MODEL = "gpt-5.1-codex";
const CODEX_UA_VERSION = "0.91.0";
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

type OpenAICodexUsageSnapshot = {
  primaryUsedPercent: number | null;
  primaryResetAfterSeconds: number | null;
  primaryWindowMinutes: number | null;
  secondaryUsedPercent: number | null;
  secondaryResetAfterSeconds: number | null;
  secondaryWindowMinutes: number | null;
  primaryOverSecondaryPercent: number | null;
  updatedAt: string;
};

type NormalizedCodexLimits = {
  used5hPercent: number | null;
  reset5hSeconds: number | null;
  window5hMinutes: number | null;
  used7dPercent: number | null;
  reset7dSeconds: number | null;
  window7dMinutes: number | null;
};

function parseNumber(value: string | null, mode: "float" | "int"): number | null {
  if (!value) {
    return null;
  }

  const parsed = mode === "float" ? Number.parseFloat(value) : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCodexRateLimitHeaders(headers: Headers): OpenAICodexUsageSnapshot | null {
  const snapshot: OpenAICodexUsageSnapshot = {
    primaryUsedPercent: parseNumber(headers.get("x-codex-primary-used-percent"), "float"),
    primaryResetAfterSeconds: parseNumber(headers.get("x-codex-primary-reset-after-seconds"), "int"),
    primaryWindowMinutes: parseNumber(headers.get("x-codex-primary-window-minutes"), "int"),
    secondaryUsedPercent: parseNumber(headers.get("x-codex-secondary-used-percent"), "float"),
    secondaryResetAfterSeconds: parseNumber(
      headers.get("x-codex-secondary-reset-after-seconds"),
      "int",
    ),
    secondaryWindowMinutes: parseNumber(headers.get("x-codex-secondary-window-minutes"), "int"),
    primaryOverSecondaryPercent: parseNumber(
      headers.get("x-codex-primary-over-secondary-limit-percent"),
      "float",
    ),
    updatedAt: new Date().toISOString(),
  };

  const hasData = Object.entries(snapshot).some(([key, value]) => key !== "updatedAt" && value !== null);
  return hasData ? snapshot : null;
}

function normalizeCodexSnapshot(snapshot: OpenAICodexUsageSnapshot | null): NormalizedCodexLimits | null {
  if (!snapshot) {
    return null;
  }

  const primaryMins = snapshot.primaryWindowMinutes ?? 0;
  const secondaryMins = snapshot.secondaryWindowMinutes ?? 0;
  const hasPrimaryWindow = snapshot.primaryWindowMinutes !== null;
  const hasSecondaryWindow = snapshot.secondaryWindowMinutes !== null;

  let use5hFromPrimary = false;
  let use7dFromPrimary = false;

  if (hasPrimaryWindow && hasSecondaryWindow) {
    if (primaryMins < secondaryMins) {
      use5hFromPrimary = true;
    } else {
      use7dFromPrimary = true;
    }
  } else if (hasPrimaryWindow) {
    if (primaryMins <= 360) {
      use5hFromPrimary = true;
    } else {
      use7dFromPrimary = true;
    }
  } else if (hasSecondaryWindow) {
    if (secondaryMins <= 360) {
      use7dFromPrimary = true;
    } else {
      use5hFromPrimary = true;
    }
  } else {
    use7dFromPrimary = true;
  }

  if (use5hFromPrimary) {
    return {
      used5hPercent: snapshot.primaryUsedPercent,
      reset5hSeconds: snapshot.primaryResetAfterSeconds,
      window5hMinutes: snapshot.primaryWindowMinutes,
      used7dPercent: snapshot.secondaryUsedPercent,
      reset7dSeconds: snapshot.secondaryResetAfterSeconds,
      window7dMinutes: snapshot.secondaryWindowMinutes,
    };
  }

  if (use7dFromPrimary) {
    return {
      used5hPercent: snapshot.secondaryUsedPercent,
      reset5hSeconds: snapshot.secondaryResetAfterSeconds,
      window5hMinutes: snapshot.secondaryWindowMinutes,
      used7dPercent: snapshot.primaryUsedPercent,
      reset7dSeconds: snapshot.primaryResetAfterSeconds,
      window7dMinutes: snapshot.primaryWindowMinutes,
    };
  }

  return null;
}

function toResetAt(updatedAt: string, resetAfterSeconds: number | null): string | null {
  if (resetAfterSeconds === null) {
    return null;
  }

  const base = Date.parse(updatedAt);
  if (!Number.isFinite(base)) {
    return null;
  }

  const safeSeconds = Math.max(0, resetAfterSeconds);
  return new Date(base + safeSeconds * 1000).toISOString();
}

function toUsageWindow(
  updatedAt: string,
  usedPercent: number | null,
  resetAfterSeconds: number | null,
  windowMinutes: number | null,
): CodexUsageWindow | null {
  if (usedPercent === null && resetAfterSeconds === null && windowMinutes === null) {
    return null;
  }

  return {
    usedPercent,
    resetAfterSeconds,
    resetAt: toResetAt(updatedAt, resetAfterSeconds),
    windowMinutes,
  };
}

function createProbePayload(): string {
  return JSON.stringify({
    model: OPENAI_TEST_MODEL,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "hi",
          },
        ],
      },
    ],
    stream: true,
    store: false,
    instructions: "You are Codex. Reply briefly.",
  });
}

function buildUsageSnapshot(
  snapshot: OpenAICodexUsageSnapshot,
  lastError: string | null = null,
): ManagedAccountUsageSnapshot {
  const normalized = normalizeCodexSnapshot(snapshot);

  return {
    kind: "codex",
    source: "openai-codex-probe",
    updatedAt: snapshot.updatedAt,
    window5h: normalized
      ? toUsageWindow(
          snapshot.updatedAt,
          normalized.used5hPercent,
          normalized.reset5hSeconds,
          normalized.window5hMinutes,
        )
      : null,
    window7d: normalized
      ? toUsageWindow(
          snapshot.updatedAt,
          normalized.used7dPercent,
          normalized.reset7dSeconds,
          normalized.window7dMinutes,
        )
      : null,
    lastError,
  };
}

function isSnapshotFresh(snapshot: ManagedAccountUsageSnapshot | null): boolean {
  if (!snapshot?.updatedAt) {
    return false;
  }

  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt < SNAPSHOT_TTL_MS;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only.
  }
}

async function probeManagedAccount(account: ManagedAccount): Promise<ManagedAccountUsageSnapshot> {
  if (!account.accessToken) {
    throw new Error("official account has no access token");
  }

  const response = await fetch(CHATGPT_CODEX_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      accept: "text/event-stream",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      version: CODEX_UA_VERSION,
      "user-agent": `codex-cli/${CODEX_UA_VERSION}`,
      ...(account.chatgptAccountId ? { "chatgpt-account-id": account.chatgptAccountId } : {}),
    },
    body: createProbePayload(),
    dispatcher: envProxyAgent || undefined,
  } as RequestInit & { dispatcher?: EnvHttpProxyAgent });

  const headerSnapshot = parseCodexRateLimitHeaders(response.headers);
  if (headerSnapshot) {
    await discardBody(response);
    return buildUsageSnapshot(headerSnapshot, response.ok ? null : `probe returned ${response.status}`);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`probe returned ${response.status}: ${bodyText.replaceAll(/\s+/g, " ").trim().slice(0, 240)}`);
  }

  throw new Error("probe succeeded but no codex usage headers were returned");
}

function mergeSnapshotError(
  previous: ManagedAccountUsageSnapshot | null,
  error: Error,
): ManagedAccountUsageSnapshot {
  const message = error.message.slice(0, 240);
  const updatedAt = new Date().toISOString();
  if (!previous) {
    return {
      kind: "codex",
      source: "openai-codex-probe",
      updatedAt,
      window5h: null,
      window7d: null,
      lastError: message,
    };
  }

  return {
    ...previous,
    updatedAt,
    lastError: message,
  };
}

export class OpenAIUsageProbeService {
  constructor(private readonly store: Store) {}

  async getManagedAccountUsageWindows(options?: {
    force?: boolean;
  }): Promise<Record<number, ManagedAccountUsageSnapshot>> {
    const accounts = this.store
      .listManagedAccounts()
      .map((account) => this.store.getManagedAccount(account.id))
      .filter((account): account is ManagedAccount => account !== null);

    const entries = await Promise.all(
      accounts.map(async (account) => {
        const cached = this.store.getManagedAccountUsageSnapshot(account.id);
        if (!options?.force && isSnapshotFresh(cached)) {
          return cached ? ([account.id, cached] as const) : null;
        }

        try {
          const snapshot = await probeManagedAccount(account);
          this.store.saveManagedAccountUsageSnapshot(account.id, snapshot);
          return [account.id, snapshot] as const;
        } catch (error) {
          const snapshot = mergeSnapshotError(
            cached,
            error instanceof Error ? error : new Error(String(error)),
          );
          this.store.saveManagedAccountUsageSnapshot(account.id, snapshot);
          return [account.id, snapshot] as const;
        }
      }),
    );

    return Object.fromEntries(entries.filter((entry) => entry !== null));
  }
}
