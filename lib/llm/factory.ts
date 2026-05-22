import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProvider } from "./types";

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
        process.env.LLM_REFERER ?? "https://my-server-test.vercel.app",
      "X-Title": process.env.LLM_TITLE ?? "Tokki Widget",
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
};

/**
 * Build an LLMProvider from environment variables.
 *
 * Returns `null` when no API key is configured — callers should treat
 * that as "fall back to a dummy / canned response".
 *
 * Env vars consulted:
 *   LLM_PROVIDER   one of: openrouter | openai | groq | together | deepseek
 *                          | mistral | fireworks | custom         (default: openrouter)
 *   LLM_API_KEY    bearer token for the chosen vendor               (required)
 *   LLM_MODEL      override default model id                        (optional)
 *   LLM_BASE_URL   override base URL (mandatory when provider=custom)
 */
export function createLLMProvider(): LLMProvider | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) return null;

  const providerName = (process.env.LLM_PROVIDER ?? "openrouter")
    .trim()
    .toLowerCase();

  if (providerName === "custom") {
    const baseUrl = process.env.LLM_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error(
        "[llm] LLM_PROVIDER=custom requires LLM_BASE_URL to be set",
      );
    }
    return new OpenAICompatibleProvider({
      name: "custom",
      baseUrl,
      apiKey,
      defaultModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
    });
  }

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
    apiKey,
    defaultModel: process.env.LLM_MODEL?.trim() || preset.defaultModel,
    extraHeaders: preset.extraHeaders?.(),
  });
}
