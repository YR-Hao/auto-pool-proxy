import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config, dbPath } from "./config.js";
import type {
  ManagedAccountUsageSnapshot,
  ProxyTargetSelection,
  ProxyTargetType,
  PricingRule,
  PublicUpstream,
  ManagedAccount,
  OpenAITokenInfo,
  PublicManagedAccount,
  UpstreamUsageWindows,
  Upstream,
  UsageLog,
  UsageRecordInput,
} from "./types.js";

type UpstreamRow = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  provider: string;
  enabled: number;
  schedule_enabled: number;
  is_default: number;
  priority: number;
  pricing_json: string;
  last_error: string | null;
  failure_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

type ManagedAccountRow = {
  id: number;
  name: string;
  platform: string;
  auth_type: string;
  email: string | null;
  plan_type: string | null;
  client_id: string | null;
  chatgpt_account_id: string | null;
  chatgpt_user_id: string | null;
  organization_id: string | null;
  enabled: number;
  schedule_enabled: number;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  last_error: string | null;
  usage_snapshot_json: string | null;
  usage_snapshot_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

type BootstrapUpstream = {
  name: string;
  baseUrl: string;
  apiKey: string;
  provider?: string;
  enabled?: boolean;
  isDefault?: boolean;
  priority?: number;
  pricingRules?: PricingRule[];
};

type AppSettingRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

type RequestLogRow = {
  id: number;
  timestamp: string;
  target_type: "upstream" | "managed_account";
  target_id: number;
  target_name: string;
  method: string;
  path: string;
  model: string | null;
  status_code: number;
  latency_ms: number;
  streamed: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: number;
  error: string | null;
};

const PROXY_TARGET_SETTING_KEY = "proxy_target";

function now(): string {
  return new Date().toISOString();
}

function maskApiKey(value: string): string {
  if (value.length <= 10) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parsePricingRules(json: string): PricingRule[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toUpstream(row: UpstreamRow): Upstream {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    provider: row.provider,
    enabled: Boolean(row.enabled),
    scheduleEnabled: Boolean(row.schedule_enabled),
    isDefault: Boolean(row.is_default),
    priority: row.priority,
    pricingRules: parsePricingRules(row.pricing_json),
    lastError: row.last_error,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicUpstream(row: UpstreamRow): PublicUpstream {
  const { apiKey: _apiKey, ...upstream } = toUpstream(row);
  return {
    ...upstream,
    apiKeyMasked: maskApiKey(row.api_key),
  };
}

function maskSecret(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 10) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function toManagedAccount(row: ManagedAccountRow): ManagedAccount {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    authType: row.auth_type,
    email: row.email,
    planType: row.plan_type,
    clientId: row.client_id,
    chatgptAccountId: row.chatgpt_account_id,
    chatgptUserId: row.chatgpt_user_id,
    organizationId: row.organization_id,
    enabled: Boolean(row.enabled),
    scheduleEnabled: Boolean(row.schedule_enabled),
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicManagedAccount(row: ManagedAccountRow): PublicManagedAccount {
  const account = toManagedAccount(row);
  const { accessToken, refreshToken, ...rest } = account;
  return {
    ...rest,
    accessTokenMasked: maskSecret(accessToken),
    refreshTokenMasked: maskSecret(refreshToken),
  };
}

function parseManagedAccountUsageSnapshot(value: string | null): ManagedAccountUsageSnapshot | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as ManagedAccountUsageSnapshot;
  } catch {
    return null;
  }
}

function defaultProxyTargetSelection(): ProxyTargetSelection {
  return {
    targetType: "auto",
    targetId: null,
    label: "自动选择",
    description: "按默认上游和故障切换策略自动代理",
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.init();
    this.loadBootstrapUpstreams();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'openai-compatible',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 100,
        pricing_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        streamed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS managed_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'openai',
        auth_type TEXT NOT NULL DEFAULT 'oauth',
        email TEXT,
        plan_type TEXT,
        client_id TEXT,
        chatgpt_account_id TEXT,
        chatgpt_user_id TEXT,
        organization_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_enabled INTEGER NOT NULL DEFAULT 1,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        last_error TEXT,
        usage_snapshot_json TEXT,
        usage_snapshot_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        target_name TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        streamed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        error TEXT
      );
    `);

    this.ensureColumnExists("upstreams", "schedule_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumnExists("managed_accounts", "schedule_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumnExists("managed_accounts", "usage_snapshot_json", "TEXT");
    this.ensureColumnExists("managed_accounts", "usage_snapshot_updated_at", "TEXT");
  }

  private ensureColumnExists(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private loadBootstrapUpstreams(): void {
    let entries: BootstrapUpstream[] = [];

    try {
      const content = readFileSync(config.upstreamsConfigPath, "utf8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("upstreams.json must be an array");
      }
      entries = parsed as BootstrapUpstream[];
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "";
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }

    this.transaction(() => {
      const timestamp = now();
      const anyDefault = entries.some((entry) => entry.isDefault);
      if (anyDefault) {
        this.db.prepare("UPDATE upstreams SET is_default = 0, updated_at = ?").run(timestamp);
      }

      for (const entry of entries) {
        const existing = this.db
          .prepare("SELECT id FROM upstreams WHERE name = ?")
          .get(entry.name.trim()) as { id: number } | undefined;

        if (existing) {
          this.db
            .prepare(
              `
                UPDATE upstreams
                SET base_url = ?, api_key = ?, provider = ?, enabled = ?, is_default = ?,
                    schedule_enabled = ?, priority = ?, pricing_json = ?, updated_at = ?
                WHERE id = ?
              `,
            )
            .run(
              entry.baseUrl.trim().replace(/\/+$/, ""),
              entry.apiKey.trim(),
              entry.provider?.trim() || "openai-compatible",
              entry.enabled === false ? 0 : 1,
              entry.isDefault ? 1 : 0,
              1,
              entry.priority ?? 100,
              JSON.stringify(entry.pricingRules || []),
              timestamp,
              existing.id,
            );
          continue;
        }

        this.db
          .prepare(
            `
              INSERT INTO upstreams (
                name, base_url, api_key, provider, enabled, schedule_enabled, is_default, priority, pricing_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            entry.name.trim(),
            entry.baseUrl.trim().replace(/\/+$/, ""),
            entry.apiKey.trim(),
            entry.provider?.trim() || "openai-compatible",
            entry.enabled === false ? 0 : 1,
            1,
            entry.isDefault ? 1 : 0,
            entry.priority ?? 100,
            JSON.stringify(entry.pricingRules || []),
            timestamp,
            timestamp,
          );
      }
    });
  }

  listUpstreams(): PublicUpstream[] {
    const rows = this.db
      .prepare("SELECT * FROM upstreams ORDER BY is_default DESC, priority ASC, id ASC")
      .all() as UpstreamRow[];
    return rows.map(toPublicUpstream);
  }

  listManagedAccounts(): PublicManagedAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM managed_accounts ORDER BY updated_at DESC, id DESC")
      .all() as ManagedAccountRow[];
    return rows.map(toPublicManagedAccount);
  }

  listEnabledUpstreams(): Upstream[] {
    const rows = this.db
      .prepare("SELECT * FROM upstreams WHERE enabled = 1 AND schedule_enabled = 1 ORDER BY is_default DESC, priority ASC, failure_count ASC, id ASC")
      .all() as UpstreamRow[];
    return rows.map(toUpstream);
  }

  getUpstream(id: number): Upstream | null {
    const row = this.db.prepare("SELECT * FROM upstreams WHERE id = ?").get(id) as UpstreamRow | undefined;
    return row ? toUpstream(row) : null;
  }

  getManagedAccount(id: number): ManagedAccount | null {
    const row = this.db.prepare("SELECT * FROM managed_accounts WHERE id = ?").get(id) as ManagedAccountRow | undefined;
    return row ? toManagedAccount(row) : null;
  }

  getProxyTarget(): ProxyTargetSelection {
    const row = this.db
      .prepare("SELECT * FROM app_settings WHERE key = ?")
      .get(PROXY_TARGET_SETTING_KEY) as AppSettingRow | undefined;
    if (!row) {
      return defaultProxyTargetSelection();
    }

    try {
      const parsed = JSON.parse(row.value_json) as {
        targetType?: ProxyTargetType;
        targetId?: number | null;
      };

      if (parsed.targetType === "upstream" && Number.isFinite(parsed.targetId)) {
        const upstream = this.getUpstream(Number(parsed.targetId));
        if (upstream) {
          return {
            targetType: "upstream",
            targetId: upstream.id,
            label: upstream.name,
            description: `固定代理到上游账号 ${upstream.name}`,
          };
        }
      }

      if (parsed.targetType === "managed_account" && Number.isFinite(parsed.targetId)) {
        const account = this.getManagedAccount(Number(parsed.targetId));
        if (account) {
          return {
            targetType: "managed_account",
            targetId: account.id,
            label: account.name,
            description: `固定代理到官方账号 ${account.name}`,
          };
        }
      }
    } catch {
      return defaultProxyTargetSelection();
    }

    return defaultProxyTargetSelection();
  }

  setProxyTarget(targetType: ProxyTargetType, targetId: number | null): ProxyTargetSelection {
    let next: ProxyTargetSelection;

    if (targetType === "auto") {
      next = defaultProxyTargetSelection();
    } else if (targetType === "upstream") {
      if (!Number.isFinite(targetId)) {
        throw new Error("upstream targetId is required");
      }
      const upstream = this.getUpstream(Number(targetId));
      if (!upstream) {
        throw new Error(`upstream ${targetId} not found`);
      }
      if (!upstream.enabled || !upstream.scheduleEnabled) {
        throw new Error(`upstream ${upstream.name} is not enabled for scheduling`);
      }
      next = {
        targetType: "upstream",
        targetId: upstream.id,
        label: upstream.name,
        description: `固定代理到上游账号 ${upstream.name}`,
      };
    } else {
      if (!Number.isFinite(targetId)) {
        throw new Error("managed account targetId is required");
      }
      const account = this.getManagedAccount(Number(targetId));
      if (!account) {
        throw new Error(`managed account ${targetId} not found`);
      }
      if (!account.enabled || !account.scheduleEnabled) {
        throw new Error(`managed account ${account.name} is not enabled for scheduling`);
      }
      if (!account.accessToken) {
        throw new Error(`managed account ${account.name} has no access token`);
      }
      next = {
        targetType: "managed_account",
        targetId: account.id,
        label: account.name,
        description: `固定代理到官方账号 ${account.name}`,
      };
    }

    this.db
      .prepare(
        `
          INSERT INTO app_settings (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `,
      )
      .run(
        PROXY_TARGET_SETTING_KEY,
        JSON.stringify({
          targetType: next.targetType,
          targetId: next.targetId,
        }),
        now(),
      );

    return next;
  }

  updateManagedAccount(
    id: number,
    patch: Partial<{
      name: string;
      enabled: boolean;
      scheduleEnabled: boolean;
    }>,
  ): PublicManagedAccount {
    const current = this.getManagedAccount(id);
    if (!current) {
      throw new Error(`managed account ${id} not found`);
    }

    this.db
      .prepare(
        `
          UPDATE managed_accounts
          SET name = ?, enabled = ?, schedule_enabled = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        patch.name?.trim() || current.name,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        (patch.scheduleEnabled ?? current.scheduleEnabled) ? 1 : 0,
        now(),
        id,
      );

    return this.requirePublicManagedAccount(id);
  }

  createUpstream(input: {
    name: string;
    baseUrl: string;
    apiKey: string;
    provider?: string;
    enabled?: boolean;
    scheduleEnabled?: boolean;
    isDefault?: boolean;
    priority?: number;
    pricingRules?: PricingRule[];
  }): PublicUpstream {
    const timestamp = now();
    const pricingJson = JSON.stringify(input.pricingRules || []);

    const id = this.transaction(() => {
      if (input.isDefault) {
        this.db.prepare("UPDATE upstreams SET is_default = 0, updated_at = ?").run(timestamp);
      }

      const result = this.db
        .prepare(
          `
            INSERT INTO upstreams (
              name, base_url, api_key, provider, enabled, schedule_enabled, is_default, priority, pricing_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.name.trim(),
          input.baseUrl.trim().replace(/\/+$/, ""),
          input.apiKey.trim(),
          input.provider?.trim() || "openai-compatible",
          input.enabled === false ? 0 : 1,
          input.scheduleEnabled === false ? 0 : 1,
          input.isDefault ? 1 : 0,
          input.priority ?? 100,
          pricingJson,
          timestamp,
          timestamp,
        );

      return Number(result.lastInsertRowid);
    });
    return this.requirePublicUpstream(id);
  }

  updateUpstream(
    id: number,
    patch: Partial<{
      name: string;
      baseUrl: string;
      apiKey: string;
      provider: string;
      enabled: boolean;
      scheduleEnabled: boolean;
      isDefault: boolean;
      priority: number;
      pricingRules: PricingRule[];
    }>,
  ): PublicUpstream {
    const current = this.getUpstream(id);
    if (!current) {
      throw new Error(`upstream ${id} not found`);
    }

    const timestamp = now();
    const next = {
      name: patch.name?.trim() || current.name,
      baseUrl: patch.baseUrl?.trim().replace(/\/+$/, "") || current.baseUrl,
      apiKey: patch.apiKey?.trim() || current.apiKey,
      provider: patch.provider?.trim() || current.provider,
      enabled: patch.enabled ?? current.enabled,
      scheduleEnabled: patch.scheduleEnabled ?? current.scheduleEnabled,
      isDefault: patch.isDefault ?? current.isDefault,
      priority: patch.priority ?? current.priority,
      pricingRules: patch.pricingRules ?? current.pricingRules,
    };

    this.transaction(() => {
      if (next.isDefault) {
        this.db.prepare("UPDATE upstreams SET is_default = 0, updated_at = ?").run(timestamp);
      }

      this.db
        .prepare(
          `
            UPDATE upstreams
            SET name = ?, base_url = ?, api_key = ?, provider = ?, enabled = ?, is_default = ?,
                schedule_enabled = ?, priority = ?, pricing_json = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          next.name,
          next.baseUrl,
          next.apiKey,
          next.provider,
          next.enabled ? 1 : 0,
          next.isDefault ? 1 : 0,
          next.scheduleEnabled ? 1 : 0,
          next.priority,
          JSON.stringify(next.pricingRules),
          timestamp,
          id,
        );
    });
    return this.requirePublicUpstream(id);
  }

  setDefaultUpstream(id: number): PublicUpstream {
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare("UPDATE upstreams SET is_default = 0, updated_at = ?").run(timestamp);
      this.db.prepare("UPDATE upstreams SET is_default = 1, updated_at = ? WHERE id = ?").run(timestamp, id);
    });
    return this.requirePublicUpstream(id);
  }

  markUpstreamSuccess(id: number): void {
    this.db
      .prepare("UPDATE upstreams SET failure_count = 0, last_error = NULL, last_used_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), id);
  }

  markUpstreamFailure(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE upstreams SET failure_count = failure_count + 1, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(error.slice(0, 500), now(), id);
  }

  recordUsage(input: UsageRecordInput): void {
    const timestamp = now();
    this.db
      .prepare(
        `
          INSERT INTO request_logs (
            timestamp, target_type, target_id, target_name, method, path, model, status_code, latency_ms, streamed,
            input_tokens, output_tokens, total_tokens, cost, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        timestamp,
        input.targetType,
        input.targetId,
        input.targetName,
        input.method,
        input.path,
        input.model,
        input.statusCode,
        input.latencyMs,
        input.streamed ? 1 : 0,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.totalTokens,
        input.cost,
        input.error,
      );
  }

  saveOpenAIAccount(input: {
    name?: string;
    authType: string;
    tokenInfo: OpenAITokenInfo;
  }): PublicManagedAccount {
    const timestamp = now();
    const resolvedName =
      input.name?.trim() ||
      input.tokenInfo.email ||
      input.tokenInfo.chatgptAccountId ||
      `openai-account-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`;

    const existing = (
      input.tokenInfo.chatgptAccountId
        ? (this.db
            .prepare("SELECT * FROM managed_accounts WHERE chatgpt_account_id = ? LIMIT 1")
            .get(input.tokenInfo.chatgptAccountId) as ManagedAccountRow | undefined)
        : undefined
    ) ||
      (input.tokenInfo.email
        ? (this.db
            .prepare("SELECT * FROM managed_accounts WHERE email = ? AND platform = 'openai' LIMIT 1")
            .get(input.tokenInfo.email) as ManagedAccountRow | undefined)
        : undefined);

    if (existing) {
      this.db
        .prepare(
          `
            UPDATE managed_accounts
            SET name = ?, auth_type = ?, email = ?, plan_type = ?, client_id = ?, chatgpt_account_id = ?,
                chatgpt_user_id = ?, organization_id = ?, enabled = 1, schedule_enabled = ?, access_token = ?, refresh_token = ?,
                expires_at = ?, last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          resolvedName,
          input.authType,
          input.tokenInfo.email,
          input.tokenInfo.planType,
          input.tokenInfo.clientId,
          input.tokenInfo.chatgptAccountId,
          input.tokenInfo.chatgptUserId,
          input.tokenInfo.organizationId,
          existing.schedule_enabled,
          input.tokenInfo.accessToken,
          input.tokenInfo.refreshToken || existing.refresh_token,
          input.tokenInfo.expiresAt,
          timestamp,
          existing.id,
        );

      return this.requirePublicManagedAccount(existing.id);
    }

    const result = this.db
      .prepare(
        `
          INSERT INTO managed_accounts (
            name, platform, auth_type, email, plan_type, client_id, chatgpt_account_id, chatgpt_user_id,
            organization_id, enabled, schedule_enabled, access_token, refresh_token, expires_at, created_at, updated_at
          ) VALUES (?, 'openai', ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        resolvedName,
        input.authType,
        input.tokenInfo.email,
        input.tokenInfo.planType,
        input.tokenInfo.clientId,
        input.tokenInfo.chatgptAccountId,
        input.tokenInfo.chatgptUserId,
        input.tokenInfo.organizationId,
        input.tokenInfo.accessToken,
        input.tokenInfo.refreshToken,
        input.tokenInfo.expiresAt,
        timestamp,
        timestamp,
      );

    return this.requirePublicManagedAccount(Number(result.lastInsertRowid));
  }

  listUsage(limit = 200): UsageLog[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM (
            SELECT
              ul.id AS id,
              ul.timestamp AS timestamp,
              'upstream' AS target_type,
              ul.upstream_id AS target_id,
              u.name AS target_name,
              ul.method AS method,
              ul.path AS path,
              ul.model AS model,
              ul.status_code AS status_code,
              ul.latency_ms AS latency_ms,
              ul.streamed AS streamed,
              ul.input_tokens AS input_tokens,
              ul.output_tokens AS output_tokens,
              ul.total_tokens AS total_tokens,
              ul.cost AS cost,
              ul.error AS error
            FROM usage_logs ul
            JOIN upstreams u ON u.id = ul.upstream_id
            UNION ALL
            SELECT
              rl.id + 1000000000 AS id,
              rl.timestamp AS timestamp,
              rl.target_type AS target_type,
              rl.target_id AS target_id,
              rl.target_name AS target_name,
              rl.method AS method,
              rl.path AS path,
              rl.model AS model,
              rl.status_code AS status_code,
              rl.latency_ms AS latency_ms,
              rl.streamed AS streamed,
              rl.input_tokens AS input_tokens,
              rl.output_tokens AS output_tokens,
              rl.total_tokens AS total_tokens,
              rl.cost AS cost,
              rl.error AS error
            FROM request_logs rl
          )
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        `,
      )
      .all(limit) as RequestLogRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: row.target_name,
      method: row.method,
      path: row.path,
      model: row.model,
      statusCode: row.status_code,
      latencyMs: row.latency_ms,
      streamed: Boolean(row.streamed),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
      error: row.error,
    }));
  }

  getSummary(windowHours = 24): {
    totals: {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cost: number;
    };
    byUpstream: Array<{
      upstreamId: number;
      upstreamName: string;
      requests: number;
      totalTokens: number;
      cost: number;
      errors: number;
    }>;
  } {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    const totals =
      (this.db
        .prepare(
        `
          WITH all_logs AS (
            SELECT
              ul.timestamp AS timestamp,
              ul.input_tokens AS input_tokens,
              ul.output_tokens AS output_tokens,
              ul.total_tokens AS total_tokens,
              ul.cost AS cost,
              ul.status_code AS status_code,
              'upstream' AS target_type,
              ul.upstream_id AS target_id,
              u.name AS target_name
            FROM usage_logs ul
            JOIN upstreams u ON u.id = ul.upstream_id
            UNION ALL
            SELECT
              rl.timestamp AS timestamp,
              rl.input_tokens AS input_tokens,
              rl.output_tokens AS output_tokens,
              rl.total_tokens AS total_tokens,
              rl.cost AS cost,
              rl.status_code AS status_code,
              rl.target_type AS target_type,
              rl.target_id AS target_id,
              rl.target_name AS target_name
            FROM request_logs rl
          )
          SELECT COUNT(*) AS requests,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(cost), 0) AS cost
          FROM all_logs
          WHERE timestamp >= ?
        `,
      )
        .get(since) as
        | {
            requests: number;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            cost: number;
          }
        | undefined) || {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: 0,
      };

    const byUpstream = this.db
      .prepare(
        `
          WITH all_logs AS (
            SELECT
              'upstream' AS target_type,
              ul.upstream_id AS target_id,
              u.name AS target_name,
              ul.timestamp AS timestamp,
              ul.total_tokens AS total_tokens,
              ul.cost AS cost,
              ul.status_code AS status_code
            FROM usage_logs ul
            JOIN upstreams u ON u.id = ul.upstream_id
            UNION ALL
            SELECT
              rl.target_type AS target_type,
              rl.target_id AS target_id,
              rl.target_name AS target_name,
              rl.timestamp AS timestamp,
              rl.total_tokens AS total_tokens,
              rl.cost AS cost,
              rl.status_code AS status_code
            FROM request_logs rl
          )
          SELECT target_id AS upstream_id, target_name AS upstream_name, COUNT(*) AS requests,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(cost), 0) AS cost,
                 COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS errors
          FROM all_logs
          WHERE timestamp >= ?
          GROUP BY target_type, target_id, target_name
          ORDER BY requests DESC, target_type ASC, target_id ASC
        `,
      )
      .all(since) as Array<{
      upstream_id: number;
      upstream_name: string;
      requests: number;
      total_tokens: number;
      cost: number;
      errors: number;
    }>;
    
    return {
      totals: {
        requests: totals.requests,
        inputTokens: totals.input_tokens,
        outputTokens: totals.output_tokens,
        totalTokens: totals.total_tokens,
        cost: totals.cost,
      },
      byUpstream: byUpstream
      .map((row) => ({
        upstreamId: row.upstream_id,
        upstreamName: row.upstream_name,
        requests: row.requests,
        totalTokens: row.total_tokens,
        cost: row.cost,
        errors: row.errors,
      })),
    };
  }

  getAccountUsageWindows(): {
    upstreams: Record<number, UpstreamUsageWindows>;
    managedAccounts: Record<number, ManagedAccountUsageSnapshot>;
  } {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db
      .prepare(
        `
          SELECT
            upstream_id,
            COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END), 0) AS req_24h,
            COALESCE(SUM(CASE WHEN timestamp >= ? THEN total_tokens ELSE 0 END), 0) AS tokens_24h,
            COALESCE(SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END), 0) AS cost_24h,
            COUNT(*) AS req_7d,
            COALESCE(SUM(total_tokens), 0) AS tokens_7d,
            COALESCE(SUM(cost), 0) AS cost_7d
          FROM (
            SELECT
              ul.upstream_id AS upstream_id,
              ul.timestamp AS timestamp,
              ul.total_tokens AS total_tokens,
              ul.cost AS cost
            FROM usage_logs ul
            UNION ALL
            SELECT
              rl.target_id AS upstream_id,
              rl.timestamp AS timestamp,
              rl.total_tokens AS total_tokens,
              rl.cost AS cost
            FROM request_logs rl
            WHERE rl.target_type = 'upstream'
          )
          WHERE timestamp >= ?
          GROUP BY upstream_id
        `,
      )
      .all(since24h, since24h, since24h, since7d) as Array<{
      upstream_id: number;
      req_24h: number;
      tokens_24h: number;
      cost_24h: number;
      req_7d: number;
      tokens_7d: number;
      cost_7d: number;
    }>;

    const upstreams: Record<number, UpstreamUsageWindows> = {};
    for (const row of rows) {
      upstreams[row.upstream_id] = {
        window24h: {
          requests: row.req_24h,
          totalTokens: row.tokens_24h,
          cost: row.cost_24h,
        },
        window7d: {
          requests: row.req_7d,
          totalTokens: row.tokens_7d,
          cost: row.cost_7d,
        },
      };
    }

    const managedAccounts: Record<number, ManagedAccountUsageSnapshot> = {};
    const managedRows = this.db
      .prepare(
        `
          SELECT id, usage_snapshot_json
          FROM managed_accounts
          WHERE usage_snapshot_json IS NOT NULL
        `,
      )
      .all() as Array<{ id: number; usage_snapshot_json: string | null }>;

    for (const row of managedRows) {
      const snapshot = parseManagedAccountUsageSnapshot(row.usage_snapshot_json);
      if (snapshot) {
        managedAccounts[row.id] = snapshot;
      }
    }

    return {
      upstreams,
      managedAccounts,
    };
  }

  saveManagedAccountUsageSnapshot(id: number, snapshot: ManagedAccountUsageSnapshot): void {
    const timestamp = snapshot.updatedAt || now();
    this.db
      .prepare(
        `
          UPDATE managed_accounts
          SET usage_snapshot_json = ?, usage_snapshot_updated_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(JSON.stringify(snapshot), timestamp, now(), id);
  }

  getManagedAccountUsageSnapshot(id: number): ManagedAccountUsageSnapshot | null {
    const row = this.db
      .prepare("SELECT usage_snapshot_json FROM managed_accounts WHERE id = ?")
      .get(id) as { usage_snapshot_json: string | null } | undefined;
    return parseManagedAccountUsageSnapshot(row?.usage_snapshot_json || null);
  }

  private requirePublicUpstream(id: number): PublicUpstream {
    const row = this.db.prepare("SELECT * FROM upstreams WHERE id = ?").get(id) as UpstreamRow | undefined;
    if (!row) {
      throw new Error(`upstream ${id} not found`);
    }
    return toPublicUpstream(row);
  }

  private requirePublicManagedAccount(id: number): PublicManagedAccount {
    const row = this.db.prepare("SELECT * FROM managed_accounts WHERE id = ?").get(id) as ManagedAccountRow | undefined;
    if (!row) {
      throw new Error(`managed account ${id} not found`);
    }
    return toPublicManagedAccount(row);
  }
}
