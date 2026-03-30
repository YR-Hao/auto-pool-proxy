export type PricingRule = {
  match: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
};

export type Upstream = {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  isDefault: boolean;
  priority: number;
  pricingRules: PricingRule[];
  lastError: string | null;
  failureCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicUpstream = Omit<Upstream, "apiKey"> & {
  apiKeyMasked: string;
};

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
};

export type UsageLog = {
  id: number;
  timestamp: string;
  targetType: "upstream" | "managed_account";
  targetId: number;
  targetName: string;
  method: string;
  path: string;
  model: string | null;
  statusCode: number;
  latencyMs: number;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  error: string | null;
};

export type UsageRecordInput = {
  targetType: "upstream" | "managed_account";
  targetId: number;
  targetName: string;
  method: string;
  path: string;
  model: string | null;
  statusCode: number;
  latencyMs: number;
  streamed: boolean;
  usage: UsageInfo;
  cost: number;
  error: string | null;
};

export type ManagedAccount = {
  id: number;
  name: string;
  platform: string;
  authType: string;
  email: string | null;
  planType: string | null;
  clientId: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  organizationId: string | null;
  enabled: boolean;
  scheduleEnabled: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicManagedAccount = Omit<ManagedAccount, "accessToken" | "refreshToken"> & {
  accessTokenMasked: string | null;
  refreshTokenMasked: string | null;
};

export type OpenAITokenInfo = {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresIn: number;
  expiresAt: number;
  clientId: string;
  email: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  organizationId: string | null;
  planType: string | null;
};

export type UsageWindowStats = {
  requests: number;
  totalTokens: number;
  cost: number;
};

export type UpstreamUsageWindows = {
  window24h: UsageWindowStats;
  window7d: UsageWindowStats;
};

export type CodexUsageWindow = {
  usedPercent: number | null;
  resetAfterSeconds: number | null;
  resetAt: string | null;
  windowMinutes: number | null;
};

export type ManagedAccountUsageSnapshot = {
  kind: "codex";
  source: "openai-codex-probe";
  updatedAt: string | null;
  window5h: CodexUsageWindow | null;
  window7d: CodexUsageWindow | null;
  lastError: string | null;
};

export type ProxyTargetType = "auto" | "upstream" | "managed_account";

export type ProxyTargetSelection = {
  targetType: ProxyTargetType;
  targetId: number | null;
  label: string;
  description: string;
};
