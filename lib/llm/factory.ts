import { OpenAICompatibleProvider } from "./openai-compatible";
import { RotatingLLMProvider } from "./rotating-provider";
import type { LLMProvider } from "./types";
import type { KeyConfig, IKeyStore } from "./key-manager/types";
import { UpstashRedisKeyStore } from "./key-manager/stores/upstash-redis";
import { MemoryKeyStore } from "./key-manager/stores/memory";

/**
 * Built-in preset for each supported vendor. Custom hosts can still be
 * used by setting LLM_PROVIDER=custom and LLM_BASE_URL=https://...
 */
const PRESETS: Record<
  string,
  {
    baseUrl: string;
    defaultModel: string;
    extraHeaders?: () => Record<string, string>;
  }
> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    extraHeaders: () => ({
      // OpenRouter uses these to attribute traffic on its leaderboard.
      "HTTP-Referer":
        process.env.LLM_REFERER ?? "https://tokki.app",
      "X-Title": process.env.LLM_TITLE ?? "Tokki AI",
    }),
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.1-70b-versatile",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  },
  /**
   * Google Gemini via its **OpenAI-compatible** endpoint.
   */
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.5-flash-lite",
  },
};

// Module-level singletons for warm serverless container reuse
let cachedRotatingProvider: RotatingLLMProvider | null = null;
let cachedKeyStore: IKeyStore | null = null;

export function getKeyStore(): IKeyStore {
  if (cachedKeyStore) return cachedKeyStore;

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (redisUrl && redisToken) {
    cachedKeyStore = new UpstashRedisKeyStore(redisUrl, redisToken, {
      timeoutMs: 500,
    });
  } else {
    cachedKeyStore = new MemoryKeyStore();
  }

  return cachedKeyStore;
}

export function resetCachedProviderForTesting(): void {
  cachedRotatingProvider = null;
  cachedKeyStore = null;
}

export function parseKeyConfigsFromEnv(): KeyConfig[] {
  const rawOpenRouterKeys =
    process.env.OPENROUTER_API_KEYS?.trim() || process.env.LLM_API_KEYS?.trim();
  const rawSingleKey = process.env.LLM_API_KEY?.trim();
  const defaultMaxConcurrency = Number(process.env.DEFAULT_KEY_MAX_CONCURRENCY || 5);

  const configs: KeyConfig[] = [];

  if (rawOpenRouterKeys) {
    if (rawOpenRouterKeys.startsWith("[") && rawOpenRouterKeys.endsWith("]")) {
      try {
        const parsed = JSON.parse(rawOpenRouterKeys);
        if (Array.isArray(parsed)) {
          parsed.forEach((item, idx) => {
            if (typeof item === "string" && item.trim()) {
              configs.push({
                id: `openrouter-key-${idx + 1}`,
                apiKey: item.trim(),
                tier: idx === 0 ? 0 : 1,
                weight: 10,
                maxConcurrency: defaultMaxConcurrency,
              });
            } else if (typeof item === "object" && item !== null && item.apiKey) {
              configs.push({
                id: item.id || `openrouter-key-${idx + 1}`,
                apiKey: item.apiKey,
                accountId: item.accountId,
                tier: typeof item.tier === "number" ? item.tier : (idx === 0 ? 0 : 1),
                weight: typeof item.weight === "number" ? item.weight : 10,
                maxConcurrency:
                  typeof item.maxConcurrency === "number"
                    ? item.maxConcurrency
                    : defaultMaxConcurrency,
              });
            }
          });
        }
      } catch (err) {
        console.warn(
          "[factory] Failed to parse JSON in OPENROUTER_API_KEYS, falling back to CSV parsing:",
          err
        );
      }
    }

    if (configs.length === 0) {
      const tokens = rawOpenRouterKeys.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      tokens.forEach((key, idx) => {
        configs.push({
          id: `openrouter-key-${idx + 1}`,
          apiKey: key,
          tier: idx === 0 ? 0 : 1,
          weight: 10,
          maxConcurrency: defaultMaxConcurrency,
        });
      });
    }
  }

  // If OPENROUTER_API_KEYS was omitted but LLM_API_KEY contains commas:
  if (configs.length === 0 && rawSingleKey && rawSingleKey.includes(",")) {
    const tokens = rawSingleKey.split(",").map((s) => s.trim()).filter(Boolean);
    tokens.forEach((key, idx) => {
      configs.push({
        id: `openrouter-key-${idx + 1}`,
        apiKey: key,
        tier: idx === 0 ? 0 : 1,
        weight: 10,
        maxConcurrency: defaultMaxConcurrency,
      });
    });
  }

  return configs;
}

/**
 * Build an LLMProvider from environment variables.
 *
 * Returns `null` when no API key is configured — callers should treat
 * that as "fall back to a dummy / canned response".
 *
 * Env vars consulted:
 *   LLM_PROVIDER          one of: openrouter | openai | groq | together | deepseek
 *                                 | mistral | fireworks | gemini | custom (default: openrouter)
 *   OPENROUTER_API_KEYS   multi-key JSON or CSV for OpenRouter rotation
 *   LLM_API_KEYS          multi-key CSV fallback
 *   LLM_API_KEY           bearer token for the chosen vendor (or single fallback key)
 *   LLM_MODEL             override default model id (optional)
 *   LLM_BASE_URL          override base URL (mandatory when provider=custom)
 */
export function createLLMProvider(): LLMProvider | null {
  const providerName = (process.env.LLM_PROVIDER ?? "openrouter")
    .trim()
    .toLowerCase();

  // If provider is OpenRouter (default):
  if (providerName === "openrouter") {
    const configs = parseKeyConfigsFromEnv();

    // Trigger rotation if multiple keys configured OR OPENROUTER_API_KEYS explicitly provided
    if (configs.length > 1 || (configs.length === 1 && process.env.OPENROUTER_API_KEYS)) {
      if (!cachedRotatingProvider) {
        const store = getKeyStore();
        const configMap = new Map<string, KeyConfig>(configs.map((c) => [c.id, c]));
        cachedRotatingProvider = new RotatingLLMProvider(store, configMap, {
          defaultModel: process.env.LLM_MODEL?.trim() || "openai/gpt-4o-mini",
          extraHeaders: {
            "HTTP-Referer":
              process.env.LLM_REFERER ?? "https://tokki.app",
            "X-Title": process.env.LLM_TITLE ?? "Tokki AI",
          },
        });
      }
      return cachedRotatingProvider;
    }

    // Single key backward compatibility
    const singleKey = process.env.LLM_API_KEY?.trim();
    if (!singleKey) return null;

    const preset = PRESETS.openrouter;
    return new OpenAICompatibleProvider({
      name: "openrouter",
      baseUrl: process.env.LLM_BASE_URL?.trim() || preset.baseUrl,
      apiKey: singleKey,
      defaultModel: process.env.LLM_MODEL?.trim() || preset.defaultModel,
      extraHeaders: preset.extraHeaders?.(),
    });
  }

  // Handle custom provider
  if (providerName === "custom") {
    const singleKey = process.env.LLM_API_KEY?.trim();
    if (!singleKey) return null;

    const baseUrl = process.env.LLM_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error(
        "[llm] LLM_PROVIDER=custom requires LLM_BASE_URL to be set",
      );
    }
    return new OpenAICompatibleProvider({
      name: "custom",
      baseUrl,
      apiKey: singleKey,
      defaultModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
    });
  }

  // Other vendor presets (openai, groq, gemini, etc.)
  const singleKey = process.env.LLM_API_KEY?.trim();
  if (!singleKey) return null;

  const preset = PRESETS[providerName];
  if (!preset) {
    throw new Error(
      `[llm] unknown LLM_PROVIDER="${providerName}". ` +
        `Pick one of: ${Object.keys(PRESETS).join(", ")}, custom`,
    );
  }

  return new OpenAICompatibleProvider({
    name: providerName,
    baseUrl: process.env.LLM_BASE_URL?.trim() || preset.baseUrl,
    apiKey: singleKey,
    defaultModel: process.env.LLM_MODEL?.trim() || preset.defaultModel,
    extraHeaders: preset.extraHeaders?.(),
  });
}
