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
  /**
   * Google Gemini via its **OpenAI-compatible** endpoint — 무료 티어가 있어
   * 잔액 소진으로 챗봇이 죽는 일이 없다(카드 등록 불필요, 만료 없음).
   * 키 발급: https://aistudio.google.com/apikey
   *
   * 모델 선택 근거(2026-09 실측, maxTokens=512 기준):
   *   gemini-3.5-flash-lite  ✅ 온전한 답변(417자) → **기본값**
   *   gemini-3.5-flash       ❌ 17자에서 잘림 — 내부 추론(thinking) 토큰이 예산을 먼저 소모
   *   gemini-3-flash-preview ❌ 20자에서 잘림 (동일 원인)
   *   gemini-3.6-flash       ❌ 200/503 번갈아 나옴(수요 폭주)
   *   gemini-2.5-*           ❌ 신규 사용자에게 차단됨(404)
   *
   * ⚠️ thinking 모델을 쓰려면 LLM_MAX_TOKENS 를 크게(2000+) 올려야 답변이 안 잘린다.
   * 기본 512 를 유지할 거면 lite 를 쓸 것.
   *
   * ⚠️ 무료 티어는 입력 내용이 구글 모델 학습에 쓰일 수 있다. 고객 상담 내용을
   * 다루므로, 민감해지면 유료 티어나 Vertex AI 로 옮길 것.
   */
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.5-flash-lite",
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
 *                          | mistral | fireworks | gemini | custom (default: openrouter)
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
