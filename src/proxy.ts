import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EnvHttpProxyAgent } from "undici";
import { calculateCost, extractUsage, SSEUsageCollector } from "./pricing.js";
import type { Store } from "./db.js";
import type { ManagedAccount, Upstream, UsageInfo } from "./types.js";
import { config } from "./config.js";

const envProxyAgent =
  process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
    ? new EnvHttpProxyAgent()
    : null;

const CHATGPT_CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_CLI_VERSION = "0.91.0";
const OFFICIAL_MODELS = [
  { id: "gpt-5.4", object: "model", created: 1772755200, owned_by: "openai", type: "model", display_name: "GPT-5.4" },
  { id: "gpt-5.3-codex", object: "model", created: 1735689600, owned_by: "openai", type: "model", display_name: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", object: "model", created: 1735689600, owned_by: "openai", type: "model", display_name: "GPT-5.3 Codex Spark" },
  { id: "gpt-5.2-codex", object: "model", created: 1733011200, owned_by: "openai", type: "model", display_name: "GPT-5.2 Codex" },
  { id: "gpt-5.1-codex-max", object: "model", created: 1730419200, owned_by: "openai", type: "model", display_name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex", object: "model", created: 1730419200, owned_by: "openai", type: "model", display_name: "GPT-5.1 Codex" },
  { id: "gpt-5.1-codex-mini", object: "model", created: 1730419200, owned_by: "openai", type: "model", display_name: "GPT-5.1 Codex Mini" },
] as const;

const EMPTY_USAGE: UsageInfo = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
};

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.includes("application/json") || contentType?.includes("application/vnd.api+json") || false;
}

function buildUpstreamUrl(baseUrl: string, pathname: string, search: string): string {
  const base = new URL(baseUrl);
  const incomingPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");

  let finalPath = incomingPath;
  if (basePath && incomingPath === basePath) {
    finalPath = basePath;
  } else if (basePath && incomingPath.startsWith(`${basePath}/`)) {
    finalPath = incomingPath;
  } else {
    finalPath = `${basePath}${incomingPath}` || "/";
  }

  base.pathname = finalPath;
  base.search = search;
  return base.toString();
}

function filterHeaders(headers: IncomingMessage["headers"], upstream: Upstream): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "authorization", "accept-encoding"].includes(lower)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }

    result.set(key, value);
  }

  result.set("authorization", `Bearer ${upstream.apiKey}`);
  result.set("accept-encoding", "identity");
  return result;
}

function copyResponseHeaders(res: ServerResponse, headers: Headers): void {
  for (const [key, value] of headers.entries()) {
    if (["content-length", "connection", "transfer-encoding"].includes(key.toLowerCase())) {
      continue;
    }
    res.setHeader(key, value);
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function shouldTrackStreaming(contentType: string | null): boolean {
  return Boolean(contentType?.includes("text/event-stream"));
}

function isStreamRequested(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "stream" in (payload as Record<string, unknown>) &&
      (payload as Record<string, unknown>).stream === true,
  );
}

function extractUsageFromBufferedBody(
  buffer: Buffer,
  contentType: string | null,
  streamRequested: boolean,
): UsageInfo {
  if (buffer.length === 0) {
    return EMPTY_USAGE;
  }

  if (shouldTrackStreaming(contentType) || streamRequested) {
    const collector = new SSEUsageCollector();
    collector.push(buffer);
    return collector.finish() || EMPTY_USAGE;
  }

  if (contentType && isJsonContentType(contentType)) {
    try {
      return extractUsage(JSON.parse(buffer.toString("utf8"))) || EMPTY_USAGE;
    } catch {
      return EMPTY_USAGE;
    }
  }

  return EMPTY_USAGE;
}

function extractUpstreamOverride(headers: IncomingMessage["headers"]): number | null {
  const raw = headers["x-upstream-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCandidates(store: Store, overrideId: number | null): Upstream[] {
  if (overrideId) {
    const upstream = store.getUpstream(overrideId);
    if (!upstream || !upstream.enabled || !upstream.scheduleEnabled) {
      return [];
    }
    return [upstream];
  }

  return store.listEnabledUpstreams();
}

function filterOfficialHeaders(headers: IncomingMessage["headers"], account: ManagedAccount): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const lower = key.toLowerCase();
    if (
      [
        "host",
        "connection",
        "content-length",
        "authorization",
        "accept-encoding",
        "openai-beta",
        "originator",
        "version",
        "chatgpt-account-id",
        "x-upstream-id",
      ].includes(lower)
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }

    result.set(key, value);
  }

  result.set("authorization", `Bearer ${account.accessToken}`);
  result.set("accept-encoding", "identity");
  result.set("openai-beta", "responses=experimental");
  result.set("originator", "codex_cli_rs");
  result.set("version", CODEX_CLI_VERSION);
  result.set("user-agent", `codex-cli/${CODEX_CLI_VERSION}`);
  if (account.chatgptAccountId) {
    result.set("chatgpt-account-id", account.chatgptAccountId);
  }
  return result;
}

function isModelsPath(pathname: string): boolean {
  return pathname === "/models" || pathname === "/v1/models";
}

function isResponsesPath(pathname: string): boolean {
  return pathname === "/responses" || pathname === "/v1/responses";
}

async function forwardOfficialAccount(
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuffer: Buffer,
  store: Store,
  account: ManagedAccount,
  targetUrl: URL,
  startedAt: number,
  model: string | null,
  streamRequested: boolean,
): Promise<void> {
  if (!account.accessToken) {
    writeJson(res, 503, { error: `managed account ${account.name} has no access token` });
    return;
  }

  if (isModelsPath(targetUrl.pathname)) {
    writeJson(res, 200, { object: "list", data: OFFICIAL_MODELS });
    return;
  }

  if (!isResponsesPath(targetUrl.pathname)) {
    writeJson(res, 501, {
      error: `managed account proxy currently supports only /v1/models and /v1/responses, got ${targetUrl.pathname}`,
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const requestBody =
    ["GET", "HEAD"].includes(req.method || "")
      ? undefined
      : (new Uint8Array(bodyBuffer.buffer, bodyBuffer.byteOffset, bodyBuffer.byteLength) as unknown as BodyInit);

  try {
    const response = await fetch(CHATGPT_CODEX_URL, {
      method: req.method,
      headers: filterOfficialHeaders(req.headers, account),
      body: requestBody,
      signal: controller.signal,
      dispatcher: envProxyAgent || undefined,
    } as RequestInit & { dispatcher?: EnvHttpProxyAgent });
    clearTimeout(timeout);

    const latencyMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type");
    const streamed = shouldTrackStreaming(contentType) || streamRequested;

    copyResponseHeaders(res, response.headers);
    res.setHeader("x-proxy-target-type", "managed_account");
    res.setHeader("x-proxy-target-id", String(account.id));
    res.setHeader("x-proxy-target-name", account.name);
    res.writeHead(response.status);

    let usage = EMPTY_USAGE;

    if (response.body) {
      if (streamed) {
        const collector = new SSEUsageCollector();
        const stream = Readable.fromWeb(response.body as never);
        for await (const chunk of stream) {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          collector.push(bufferChunk);
          res.write(bufferChunk);
        }
        usage = collector.finish() || EMPTY_USAGE;
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.end(buffer);
        usage = extractUsageFromBufferedBody(buffer, contentType, streamRequested);
      }
    }

    if (!res.writableEnded) {
      res.end();
    }

    store.recordUsage({
      targetType: "managed_account",
      targetId: account.id,
      targetName: account.name,
      method: req.method || "GET",
      path: targetUrl.pathname,
      model,
      statusCode: response.status,
      latencyMs,
      streamed,
      usage,
      cost: calculateCost(model, usage, []),
      error: response.status >= 400 ? `managed account status ${response.status}` : null,
    });
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 502, { error: message });
  }
}

export async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuffer: Buffer,
  store: Store,
): Promise<void> {
  const startedAt = Date.now();
  const targetUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const bodyText = bodyBuffer.length ? bodyBuffer.toString("utf8") : "";
  const maybeJsonBody =
    bodyText && isJsonContentType(req.headers["content-type"])
      ? (() => {
          try {
            return JSON.parse(bodyText);
          } catch {
            return null;
          }
        })()
      : null;

  const overrideId = extractUpstreamOverride(req.headers);
  const model =
    maybeJsonBody && typeof maybeJsonBody === "object" && "model" in maybeJsonBody
      ? String((maybeJsonBody as Record<string, unknown>).model || "")
      : null;
  const streamRequested = isStreamRequested(maybeJsonBody);

  const candidates = getCandidates(store, overrideId);
  const proxyTarget = overrideId ? null : store.getProxyTarget();
  if (!overrideId && proxyTarget?.targetType === "managed_account") {
    const account = proxyTarget.targetId ? store.getManagedAccount(proxyTarget.targetId) : null;
    if (!account || !account.enabled || !account.scheduleEnabled) {
      writeJson(res, 503, {
        error: "selected managed account is unavailable",
        proxyTarget,
      });
      return;
    }
    await forwardOfficialAccount(
      req,
      res,
      bodyBuffer,
      store,
      account,
      targetUrl,
      startedAt,
      model,
      streamRequested,
    );
    return;
  }

  const effectiveCandidates =
    !overrideId && proxyTarget?.targetType === "upstream" && proxyTarget.targetId
      ? getCandidates(store, proxyTarget.targetId)
      : candidates;
  if (effectiveCandidates.length === 0) {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "no enabled upstream available",
        requestedUpstreamId: overrideId,
      }),
    );
    return;
  }

  const errors: string[] = [];

  for (const upstream of effectiveCandidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const requestBody =
      ["GET", "HEAD"].includes(req.method || "")
        ? undefined
        : (new Uint8Array(
            bodyBuffer.buffer,
            bodyBuffer.byteOffset,
            bodyBuffer.byteLength,
          ) as unknown as BodyInit);

    try {
      const response = await fetch(buildUpstreamUrl(upstream.baseUrl, targetUrl.pathname, targetUrl.search), {
        method: req.method,
        headers: filterHeaders(req.headers, upstream),
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      store.markUpstreamSuccess(upstream.id);

      const latencyMs = Date.now() - startedAt;
      const contentType = response.headers.get("content-type");
      const streamed = shouldTrackStreaming(contentType) || streamRequested;

      copyResponseHeaders(res, response.headers);
      res.setHeader("x-proxy-upstream-id", String(upstream.id));
      res.setHeader("x-proxy-upstream-name", upstream.name);
      res.setHeader("x-proxy-target-type", "upstream");
      res.setHeader("x-proxy-target-id", String(upstream.id));
      res.setHeader("x-proxy-target-name", upstream.name);
      res.writeHead(response.status);

      let usage = EMPTY_USAGE;

      if (response.body) {
        if (streamed) {
          const collector = new SSEUsageCollector();
          const stream = Readable.fromWeb(response.body as any);
          for await (const chunk of stream) {
            const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            collector.push(bufferChunk);
            res.write(bufferChunk);
          }
          usage = collector.finish() || EMPTY_USAGE;
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          res.end(buffer);
          usage = extractUsageFromBufferedBody(buffer, contentType, streamRequested);
        }
      }

      if (!streamed) {
        if (!res.writableEnded) {
          res.end();
        }
      } else {
        res.end();
      }

      const cost = calculateCost(model, usage, upstream.pricingRules);
      store.recordUsage({
        targetType: "upstream",
        targetId: upstream.id,
        targetName: upstream.name,
        method: req.method || "GET",
        path: targetUrl.pathname,
        model,
        statusCode: response.status,
        latencyMs,
        streamed,
        usage,
        cost,
        error: response.status >= 400 ? `upstream status ${response.status}` : null,
      });

      return;
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${upstream.name}: ${message}`);
      store.markUpstreamFailure(upstream.id, message);
    }
  }

  const first = errors[0] || "upstream request failed";
  res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      error: first,
      detail: errors,
    }),
  );
}
