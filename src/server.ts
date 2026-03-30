import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, dbPath } from "./config.js";
import { runConnectivityTest } from "./connectivity.js";
import { Store } from "./db.js";
import { OpenAIOAuthManager, parseCodeOrCallback } from "./openai-oauth.js";
import { OpenAIUsageProbeService } from "./openai-usage.js";
import { handleProxyRequest } from "./proxy.js";
import type { PricingRule, ProxyTargetType } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const store = new Store();
const openaiOAuth = new OpenAIOAuthManager();
const openaiUsage = new OpenAIUsageProbeService(store);
let latestOAuthCallback: { value: string; timestamp: number } | null = null;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!config.adminToken) {
    return true;
  }

  const auth = req.headers.authorization;
  return auth === `Bearer ${config.adminToken}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseBodyJson(body: Buffer): unknown {
  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
}

function parsePricingRules(value: unknown): PricingRule[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value as PricingRule[];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    return JSON.parse(trimmed) as PricingRule[];
  }

  throw new Error("pricingRules must be a JSON array or empty");
}

async function serveStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  const fullPath = path.join(publicDir, filePath);
  const content = await readFile(fullPath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": content.length,
  });
  res.end(content);
}

async function serveAuthCallbackPage(res: ServerResponse): Promise<void> {
  const fullPath = path.join(publicDir, "auth-callback.html");
  const raw = await readFile(fullPath, "utf8");
  const content = raw.replaceAll("__APP_ORIGIN__", `http://${config.host}:${config.port}`);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(content),
  });
  res.end(content);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) {
    return false;
  }

  const isOAuthCallbackCache = url.pathname === "/api/openai/oauth/callback-cache";

  if (!isOAuthCallbackCache && !isAuthorized(req)) {
    sendError(res, 401, "unauthorized");
    return true;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        host: config.host,
        port: config.port,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      sendJson(res, 200, {
        summary: store.getSummary(),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/account-usage-windows") {
      const managedAccounts = await openaiUsage.getManagedAccountUsageWindows({
        force: url.searchParams.get("refresh") === "1",
      });
      sendJson(res, 200, {
        usageWindows: {
          ...store.getAccountUsageWindows(),
          managedAccounts,
        },
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/proxy-target") {
      sendJson(res, 200, {
        proxyTarget: store.getProxyTarget(),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/proxy-target") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const targetType = String(body.targetType || "auto").trim() as ProxyTargetType;
      const targetId =
        body.targetId === null || body.targetId === undefined || body.targetId === ""
          ? null
          : Number(body.targetId);
      if (!["auto", "upstream", "managed_account"].includes(targetType)) {
        sendError(res, 400, "invalid targetType");
        return true;
      }
      const proxyTarget = store.setProxyTarget(
        targetType,
        targetId !== null && Number.isFinite(targetId) ? targetId : null,
      );
      sendJson(res, 200, { proxyTarget });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/upstreams") {
      sendJson(res, 200, {
        upstreams: store.listUpstreams(),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/upstreams") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const upstream = store.createUpstream({
        name: String(body.name || ""),
        baseUrl: String(body.baseUrl || ""),
        apiKey: String(body.apiKey || ""),
        provider: body.provider ? String(body.provider) : "openai-compatible",
        enabled: body.enabled !== false,
        scheduleEnabled: body.scheduleEnabled !== false,
        isDefault: body.isDefault === true,
        priority: Number(body.priority || 100),
        pricingRules: parsePricingRules(body.pricingRules),
      });
      sendJson(res, 201, { upstream });
      return true;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/upstreams/")) {
      const id = Number.parseInt(url.pathname.split("/")[3] || "", 10);
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const upstream = store.updateUpstream(id, {
        name: body.name ? String(body.name) : undefined,
        baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
        apiKey: body.apiKey ? String(body.apiKey) : undefined,
        provider: body.provider ? String(body.provider) : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        scheduleEnabled: typeof body.scheduleEnabled === "boolean" ? body.scheduleEnabled : undefined,
        isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
        priority: body.priority !== undefined ? Number(body.priority) : undefined,
        pricingRules: body.pricingRules !== undefined ? parsePricingRules(body.pricingRules) : undefined,
      });
      sendJson(res, 200, { upstream });
      return true;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/upstreams\/\d+\/default$/)) {
      const id = Number.parseInt(url.pathname.split("/")[3] || "", 10);
      const upstream = store.setDefaultUpstream(id);
      sendJson(res, 200, { upstream });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/connectivity/test") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const targetType = String(body.targetType || "").trim() as "upstream" | "managed_account";
      const targetId = Number(body.targetId);
      if (!["upstream", "managed_account"].includes(targetType) || !Number.isFinite(targetId)) {
        sendError(res, 400, "targetType and targetId are required");
        return true;
      }

      const result = await runConnectivityTest(store, targetType, targetId);
      sendJson(res, 200, { result });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/openai/accounts") {
      sendJson(res, 200, {
        accounts: store.listManagedAccounts(),
      });
      return true;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/openai\/accounts\/\d+$/)) {
      const id = Number.parseInt(url.pathname.split("/")[4] || "", 10);
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const account = store.updateManagedAccount(id, {
        name: body.name ? String(body.name) : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        scheduleEnabled: typeof body.scheduleEnabled === "boolean" ? body.scheduleEnabled : undefined,
      });
      sendJson(res, 200, { account });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/openai/oauth/callback-cache") {
      res.setHeader("access-control-allow-origin", "*");
      sendJson(res, 200, {
        callback: latestOAuthCallback,
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/openai/oauth/callback-cache") {
      res.setHeader("access-control-allow-origin", "*");
      const body = await readBody(req);
      const value = body.toString("utf8").trim();
      latestOAuthCallback = value
        ? {
            value,
            timestamp: Date.now(),
          }
        : null;
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/openai/oauth/generate-auth-url") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const payload = openaiOAuth.generateAuthUrl(
        body.redirectUri ? String(body.redirectUri) : undefined,
      );
      sendJson(res, 200, payload);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/openai/oauth/exchange-code") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const sessionId = String(body.sessionId || "").trim();
      const rawCodeInput = String(body.code || "").trim();
      if (!sessionId || !rawCodeInput) {
        sendError(res, 400, "sessionId and code are required");
        return true;
      }

      const parsed = parseCodeOrCallback(rawCodeInput);
      const state = parsed.state || String(body.state || "").trim();
      if (!state) {
        sendError(res, 400, "state is required");
        return true;
      }

      const tokenInfo = await openaiOAuth.exchangeCode({
        sessionId,
        code: parsed.code,
        state,
        redirectUri: body.redirectUri ? String(body.redirectUri) : undefined,
      });

      const account = store.saveOpenAIAccount({
        name: body.name ? String(body.name) : undefined,
        authType: "oauth",
        tokenInfo,
      });

      sendJson(res, 200, { account, tokenInfo });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/openai/oauth/import-refresh-token") {
      const body = parseBodyJson(await readBody(req)) as Record<string, unknown>;
      const refreshToken = String(body.refreshToken || "").trim();
      if (!refreshToken) {
        sendError(res, 400, "refreshToken is required");
        return true;
      }

      const tokenInfo = await openaiOAuth.refreshToken(
        refreshToken,
        body.clientId ? String(body.clientId) : undefined,
      );

      const account = store.saveOpenAIAccount({
        name: body.name ? String(body.name) : undefined,
        authType: "refresh_token",
        tokenInfo,
      });

      sendJson(res, 200, { account, tokenInfo });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/usage") {
      sendJson(res, 200, {
        usage: store.listUsage(),
      });
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
    return true;
  }

  sendError(res, 404, "not found");
  return true;
}

async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    await serveStatic(res, "index.html", "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/app.js") {
    await serveStatic(res, "app.js", "text/javascript; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/styles.css") {
    await serveStatic(res, "styles.css", "text/css; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    await serveAuthCallbackPage(res);
    return;
  }

  if (await handleApi(req, res, url)) {
    return;
  }

  const body = await readBody(req);
  await handleProxyRequest(req, res, body, store);
}

const server = createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, message);
  });
});

server.listen(config.port, config.host, () => {
  console.log(
    `codex-switchboard listening on http://${config.host}:${config.port} | db=${path.relative(process.cwd(), dbPath)}`,
  );
});

const callbackServer = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    serveAuthCallbackPage(res).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, message);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/styles.css") {
    serveStatic(res, "styles.css", "text/css; charset=utf-8").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, message);
    });
    return;
  }

  sendError(res, 404, "not found");
});

callbackServer.listen(config.oauthCallbackPort, config.oauthCallbackHost, () => {
  console.log(
    `oauth callback listening on http://localhost:${config.oauthCallbackPort}/auth/callback`,
  );
});
