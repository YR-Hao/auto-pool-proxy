import path from "node:path";

const cwd = process.cwd();

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: readNumber("PORT", 5728),
  oauthCallbackHost: process.env.OAUTH_CALLBACK_HOST?.trim() || "127.0.0.1",
  oauthCallbackPort: readNumber("OAUTH_CALLBACK_PORT", 1455),
  dataDir: process.env.DATA_DIR?.trim() || path.join(cwd, "data"),
  upstreamsConfigPath:
    process.env.UPSTREAMS_CONFIG_PATH?.trim() || path.join(cwd, "upstreams.json"),
  requestTimeoutMs: readNumber("REQUEST_TIMEOUT_MS", 300_000),
  adminToken: process.env.ADMIN_TOKEN?.trim() || "",
};

export const dbPath = path.join(config.dataDir, "switchboard.sqlite");
