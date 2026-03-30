import { EnvHttpProxyAgent } from "undici";
import type { Store } from "./db.js";

const envProxyAgent =
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
    ? new EnvHttpProxyAgent()
    : null;

const OPENAI_TEST_MODEL = "gpt-5.1-codex";
const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

export type ConnectivityTargetType = "upstream" | "managed_account";

export type ConnectivityResult = {
  ok: boolean;
  targetType: ConnectivityTargetType;
  targetId: number;
  targetName: string;
  endpoint: string;
  statusCode: number | null;
  latencyMs: number;
  summary: string;
  snippet: string;
};

function trimSnippet(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().slice(0, 400);
}

function buildProxyFetchInit(init: RequestInit): RequestInit & { dispatcher?: EnvHttpProxyAgent } {
  return {
    ...init,
    dispatcher: envProxyAgent || undefined,
  };
}

function buildUpstreamModelsUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/models`;
  base.search = "";
  return base.toString();
}

function createOpenAIOAuthTestPayload(): string {
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

async function testUpstream(store: Store, id: number): Promise<ConnectivityResult> {
  const upstream = store.getUpstream(id);
  if (!upstream) {
    throw new Error(`upstream ${id} not found`);
  }

  const endpoint = buildUpstreamModelsUrl(upstream.baseUrl);
  const startedAt = Date.now();
  const response = await fetch(
    endpoint,
    buildProxyFetchInit({
      method: "GET",
      headers: {
        authorization: `Bearer ${upstream.apiKey}`,
        "user-agent": "codex-switchboard/0.1.0",
      },
    }),
  );
  const latencyMs = Date.now() - startedAt;
  const bodyText = await response.text();

  return {
    ok: response.ok,
    targetType: "upstream",
    targetId: upstream.id,
    targetName: upstream.name,
    endpoint,
    statusCode: response.status,
    latencyMs,
    summary: response.ok ? "上游 OpenAI 兼容 models 接口可达" : "上游响应异常",
    snippet: trimSnippet(bodyText),
  };
}

async function testManagedAccount(store: Store, id: number): Promise<ConnectivityResult> {
  const account = store.getManagedAccount(id);
  if (!account) {
    throw new Error(`managed account ${id} not found`);
  }
  if (!account.accessToken) {
    throw new Error("managed account has no access token");
  }

  const startedAt = Date.now();
  const response = await fetch(
    CHATGPT_CODEX_URL,
    buildProxyFetchInit({
      method: "POST",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        accept: "text/event-stream",
        "content-type": "application/json",
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
        "user-agent": "codex-cli/0.91.0",
        ...(account.chatgptAccountId ? { "chatgpt-account-id": account.chatgptAccountId } : {}),
      },
      body: createOpenAIOAuthTestPayload(),
    }),
  );
  const latencyMs = Date.now() - startedAt;
  const bodyText = await response.text();

  return {
    ok: response.ok,
    targetType: "managed_account",
    targetId: account.id,
    targetName: account.name,
    endpoint: CHATGPT_CODEX_URL,
    statusCode: response.status,
    latencyMs,
    summary: response.ok ? "官方账号 Codex Responses 链路可达" : "官方账号响应异常",
    snippet: trimSnippet(bodyText),
  };
}

export async function runConnectivityTest(
  store: Store,
  targetType: ConnectivityTargetType,
  id: number,
): Promise<ConnectivityResult> {
  if (targetType === "upstream") {
    return testUpstream(store, id);
  }

  return testManagedAccount(store, id);
}
