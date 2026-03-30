import type { PricingRule, UsageInfo } from "./types.js";

type ResolvedPricing = {
  match: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  source: "custom" | "openai_official";
};

const OFFICIAL_OPENAI_PRICING: Record<
  string,
  Omit<ResolvedPricing, "source" | "match">
> = {
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
  },
  "gpt-5.2": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
  },
  "gpt-5.1": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5-mini": {
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2,
  },
  "gpt-5-nano": {
    inputPerMillion: 0.05,
    cachedInputPerMillion: 0.005,
    outputPerMillion: 0.4,
  },
  "gpt-5.2-chat-latest": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
  },
  "gpt-5.1-chat-latest": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5-chat-latest": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5.2-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
  },
  "gpt-5.1-codex-max": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5.1-codex": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5-codex": {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10,
  },
  "gpt-5.1-codex-mini": {
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2,
  },
  "codex-mini-latest": {
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.375,
    outputPerMillion: 6,
  },
  "gpt-5.2-pro": {
    inputPerMillion: 21,
    outputPerMillion: 168,
  },
  "gpt-5-pro": {
    inputPerMillion: 15,
    outputPerMillion: 120,
  },
  "gpt-4.1": {
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8,
  },
  "gpt-4.1-mini": {
    inputPerMillion: 0.4,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 1.6,
  },
  "gpt-4.1-nano": {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 0.4,
  },
  "gpt-4o": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10,
  },
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
  },
};

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const regex = escapeRegex(pattern).replaceAll("*", ".*");
  return new RegExp(`^${regex}$`, "i");
}

function normalizeModelId(model: string): string {
  if (!model.trim()) {
    return "gpt-5.1";
  }

  const modelId = model.includes("/") ? model.split("/").at(-1) || model : model;
  const normalized = modelId.trim().toLowerCase();

  const aliases = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2-codex",
    "gpt-5.2-chat-latest",
    "gpt-5.2-pro",
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1-chat-latest",
    "gpt-5.1",
    "gpt-5-chat-latest",
    "gpt-5-codex",
    "gpt-5-pro",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
    "codex-mini-latest",
  ];

  for (const alias of aliases.sort((a, b) => b.length - a.length)) {
    if (normalized === alias || normalized.startsWith(`${alias}-`)) {
      return alias;
    }
  }

  if (normalized.includes("gpt 5.4 mini")) return "gpt-5.4-mini";
  if (normalized.includes("gpt 5.4 nano")) return "gpt-5.4-nano";
  if (normalized.includes("gpt 5.4")) return "gpt-5.4";
  if (normalized.includes("gpt 5.3 codex") || normalized.includes("gpt 5.3")) return "gpt-5.3-codex";
  if (normalized.includes("gpt 5.2 codex")) return "gpt-5.2-codex";
  if (normalized.includes("gpt 5.2")) return "gpt-5.2";
  if (normalized.includes("gpt 5.1 codex mini")) return "gpt-5.1-codex-mini";
  if (normalized.includes("gpt 5.1 codex max")) return "gpt-5.1-codex-max";
  if (normalized.includes("gpt 5.1 codex")) return "gpt-5.1-codex";
  if (normalized.includes("gpt 5.1")) return "gpt-5.1";
  if (normalized.includes("codex-mini-latest") || normalized.includes("gpt 5 codex mini")) {
    return "codex-mini-latest";
  }
  if (normalized.includes("codex")) return "gpt-5.1-codex";
  if (normalized.includes("gpt 5")) return "gpt-5.1";

  return normalized;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeUsage(raw: Record<string, unknown>): UsageInfo | null {
  const inputTokens =
    asNumber(raw.input_tokens) ||
    asNumber(raw.prompt_tokens) ||
    asNumber(raw.inputTokens);
  const outputTokens =
    asNumber(raw.output_tokens) ||
    asNumber(raw.completion_tokens) ||
    asNumber(raw.outputTokens);
  const totalTokens =
    asNumber(raw.total_tokens) || asNumber(raw.totalTokens) || inputTokens + outputTokens;

  const inputDetails =
    raw.input_tokens_details && typeof raw.input_tokens_details === "object"
      ? (raw.input_tokens_details as Record<string, unknown>)
      : raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
        ? (raw.prompt_tokens_details as Record<string, unknown>)
        : null;

  const cachedInputTokens =
    asNumber(raw.cached_input_tokens) ||
    asNumber(raw.cache_read_input_tokens) ||
    asNumber(inputDetails?.cached_tokens) ||
    asNumber(inputDetails?.cachedTokens) ||
    asNumber(raw.cached_tokens);

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
  };
}

export function extractUsage(payload: unknown, depth = 0): UsageInfo | null {
  if (!payload || typeof payload !== "object" || depth > 5) {
    return null;
  }

  const record = payload as Record<string, unknown>;

  if (record.usage && typeof record.usage === "object") {
    const direct = normalizeUsage(record.usage as Record<string, unknown>);
    if (direct) {
      return direct;
    }
  }

  const nestedCandidates = [record.response, record.data, record.delta, record.item];
  for (const candidate of nestedCandidates) {
    const extracted = extractUsage(candidate, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const extracted = extractUsage(item, depth + 1);
        if (extracted) {
          return extracted;
        }
      }
      continue;
    }

    const extracted = extractUsage(value, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return normalizeUsage(record);
}

export function calculateCost(
  model: string | null,
  usage: UsageInfo,
  rules: PricingRule[],
): number {
  if (!model) {
    return 0;
  }

  const normalizedModel = normalizeModelId(model);
  const customRule = rules.find((item) => globToRegex(item.match).test(model));
  const rule: ResolvedPricing | null = customRule
    ? {
        ...customRule,
        source: "custom",
      }
    : OFFICIAL_OPENAI_PRICING[normalizedModel]
      ? {
          match: normalizedModel,
          ...OFFICIAL_OPENAI_PRICING[normalizedModel],
          source: "openai_official",
        }
      : null;

  if (!rule) {
    return 0;
  }

  const billableInput = Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
  const cachedInput = Math.max(usage.cachedInputTokens, 0);
  const inputCost = (billableInput / 1_000_000) * (rule.inputPerMillion || 0);
  const cachedInputCost = (cachedInput / 1_000_000) * (rule.cachedInputPerMillion || 0);
  const outputCost = (usage.outputTokens / 1_000_000) * (rule.outputPerMillion || 0);

  return Number((inputCost + cachedInputCost + outputCost).toFixed(6));
}

export class SSEUsageCollector {
  private buffer = "";

  private lastUsage: UsageInfo | null = null;

  push(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8").replaceAll("\r\n", "\n");
    this.drain();
  }

  finish(): UsageInfo | null {
    this.buffer += "\n\n";
    this.drain();
    return this.lastUsage;
  }

  private drain(): void {
    while (true) {
      const delimiterIndex = this.buffer.indexOf("\n\n");
      if (delimiterIndex === -1) {
        break;
      }

      const eventBlock = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + 2);

      const data = eventBlock
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const eventType =
          parsed && typeof parsed === "object" && "type" in parsed ? String(parsed.type || "") : "";
        if (
          eventType &&
          eventType.startsWith("response.") &&
          eventType !== "response.completed" &&
          eventType !== "response.done"
        ) {
          continue;
        }
        const usage = extractUsage(parsed);
        if (usage) {
          this.lastUsage = usage;
        }
      } catch {
        continue;
      }
    }
  }
}
