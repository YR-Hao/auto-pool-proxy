import crypto from "node:crypto";
import { EnvHttpProxyAgent } from "undici";
import { config } from "./config.js";
import type { OpenAITokenInfo } from "./types.js";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_SCOPES = "openid profile email offline_access";
const OPENAI_REFRESH_SCOPES = "openid profile email";
const SESSION_TTL_MS = 30 * 60 * 1000;
const envProxyAgent =
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
    ? new EnvHttpProxyAgent()
    : null;

type OAuthSession = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

type RawJWTClaims = {
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_user_id?: string;
    chatgpt_plan_type?: string;
    organizations?: Array<{
      id?: string;
      is_default?: boolean;
    }>;
  };
};

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeJWTClaims(token: string | null): RawJWTClaims | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payload = parts[1];
  if (!payload) {
    return null;
  }

  let padded = payload;
  switch (payload.length % 4) {
    case 2:
      padded += "==";
      break;
    case 3:
      padded += "=";
      break;
    default:
      break;
  }

  try {
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as RawJWTClaims;
  } catch {
    try {
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as RawJWTClaims;
    } catch {
      return null;
    }
  }
}

function normalizeOrganizationId(claims: RawJWTClaims | null): string | null {
  const organizations = claims?.["https://api.openai.com/auth"]?.organizations;
  if (!organizations?.length) {
    return null;
  }

  const preferred = organizations.find((item) => item.is_default && item.id)?.id;
  return preferred || organizations[0]?.id || null;
}

function extractUserInfo(idToken: string | null): Pick<
  OpenAITokenInfo,
  "email" | "chatgptAccountId" | "chatgptUserId" | "organizationId" | "planType"
> {
  const claims = decodeJWTClaims(idToken);
  const auth = claims?.["https://api.openai.com/auth"];

  return {
    email: claims?.email || null,
    chatgptAccountId: auth?.chatgpt_account_id || null,
    chatgptUserId: auth?.chatgpt_user_id || null,
    organizationId: normalizeOrganizationId(claims),
    planType: auth?.chatgpt_plan_type || null,
  };
}

function parseFormPayload(data: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    form.set(key, value);
  }
  return form;
}

function defaultRedirectUri(): string {
  return `http://localhost:${config.oauthCallbackPort}/auth/callback`;
}

export function parseCodeOrCallback(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("code or callback url is required");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code")?.trim() || "";
    const state = url.searchParams.get("state")?.trim() || null;
    if (!code) {
      throw new Error("callback url does not contain code");
    }
    return { code, state };
  }

  return { code: trimmed, state: null };
}

export class OpenAIOAuthManager {
  private readonly sessions = new Map<string, OAuthSession>();

  constructor() {
    setInterval(() => {
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.createdAt < cutoff) {
          this.sessions.delete(sessionId);
        }
      }
    }, 5 * 60 * 1000).unref();
  }

  generateAuthUrl(redirectUri = defaultRedirectUri()): {
    authUrl: string;
    sessionId: string;
    state: string;
    redirectUri: string;
  } {
    const state = randomHex(32);
    const sessionId = randomHex(16);
    const codeVerifier = randomHex(64);
    const challenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());

    this.sessions.set(sessionId, {
      state,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: OPENAI_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });

    return {
      authUrl: `${OPENAI_AUTHORIZE_URL}?${params.toString()}`,
      sessionId,
      state,
      redirectUri,
    };
  }

  async exchangeCode(input: {
    sessionId: string;
    code: string;
    state: string;
    redirectUri?: string;
  }): Promise<OpenAITokenInfo> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error("oauth session not found or expired");
    }

    if (session.state !== input.state) {
      throw new Error("oauth state mismatch");
    }

    const redirectUri = input.redirectUri?.trim() || session.redirectUri;
    const tokenInfo = await this.requestToken(
      parseFormPayload({
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code: input.code.trim(),
        redirect_uri: redirectUri,
        code_verifier: session.codeVerifier,
      }),
    );

    this.sessions.delete(input.sessionId);
    return tokenInfo;
  }

  async refreshToken(refreshToken: string, clientId = OPENAI_CLIENT_ID): Promise<OpenAITokenInfo> {
    return this.requestToken(
      parseFormPayload({
        grant_type: "refresh_token",
        refresh_token: refreshToken.trim(),
        client_id: clientId.trim() || OPENAI_CLIENT_ID,
        scope: OPENAI_REFRESH_SCOPES,
      }),
    );
  }

  private async requestToken(form: URLSearchParams): Promise<OpenAITokenInfo> {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "codex-cli/0.91.0",
      },
      body: form.toString(),
      dispatcher: envProxyAgent || undefined,
    } as RequestInit & { dispatcher?: EnvHttpProxyAgent });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`openai oauth failed: ${response.status} ${bodyText.slice(0, 300)}`);
    }

    const payload = JSON.parse(bodyText) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!payload.access_token) {
      throw new Error("openai oauth did not return access_token");
    }

    const expiresIn = Number(payload.expires_in || 0);
    const userInfo = extractUserInfo(payload.id_token || null);

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || "",
      idToken: payload.id_token || null,
      expiresIn,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      clientId: form.get("client_id") || OPENAI_CLIENT_ID,
      ...userInfo,
    };
  }
}
