import { t } from "elysia";
import net from "net";
import { createLLMProvider, type ChatContentPart, type ChatMessage } from "../../../lib/llm";
import { timingSafeMatch } from "./widget-endpoints";

const MAX_SYSTEM_CHARS = 20_000;
const MAX_PROMPT_CHARS = 30_000;
const MAX_IMAGES = 5;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB per remote image
const MAX_DATA_URI_CHARS = 950_000; // Fits safely inside 1MB JSON body guard

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // Cloud metadata / link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  // Block shorthand/hex/octal numeric hostnames
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^[0-9.]+$/.test(host)) {
    return net.isIPv4(host) ? isPrivateOrReservedIpv4(host) : true;
  }
  if (host.includes(":") || net.isIPv6(host)) {
    // Reject all IPv6 literals for remote image fetches
    return true;
  }
  return false;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: GIF87a or GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function validateRemoteImageUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s<>"'`\\\x00-\x1f\x7f]/.test(trimmed)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  if (isBlockedHost(parsed.hostname)) return null;
  return parsed;
}

async function resolveImageDataUri(
  raw: string,
): Promise<{ ok: true; dataUri: string } | { ok: false; fatal: boolean; error: string }> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, fatal: true, error: "empty imageUrl entry" };
  }

  // Case 1: Inline data URI
  if (trimmed.startsWith("data:")) {
    if (trimmed.length > MAX_DATA_URI_CHARS) {
      return { ok: false, fatal: true, error: "data URI image exceeds maximum allowed size" };
    }
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
    if (!m) {
      return { ok: false, fatal: true, error: "invalid data URI format (must be base64 jpeg/png/webp/gif)" };
    }
    const buf = Buffer.from(m[2], "base64");
    const sniffed = sniffImageMime(buf);
    if (!sniffed) {
      return { ok: false, fatal: true, error: "data URI payload is not a valid image binary" };
    }
    return { ok: true, dataUri: `data:${sniffed};base64,${buf.toString("base64")}` };
  }

  // Case 2: Remote HTTPS image URL
  const validUrl = validateRemoteImageUrl(trimmed);
  if (!validUrl) {
    return {
      ok: false,
      fatal: true,
      error: "disallowed imageUrl (must be public HTTPS port 443 URL without private/IP literals)",
    };
  }

  try {
    const resp = await fetch(validUrl.toString(), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      return { ok: false, fatal: false, error: `upstream image HTTP ${resp.status}` };
    }
    const cl = Number(resp.headers.get("content-length") ?? "0");
    if (cl > MAX_REMOTE_IMAGE_BYTES) {
      return { ok: false, fatal: false, error: "remote image exceeds 6MB limit" };
    }
    if (!resp.body) {
      return { ok: false, fatal: false, error: "empty image body" };
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel().catch(() => {});
            return { ok: false, fatal: false, error: "remote image stream exceeded 6MB limit" };
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mime = sniffImageMime(merged);
    if (!mime) {
      return { ok: false, fatal: false, error: "remote file is not a supported image (jpeg/png/webp/gif)" };
    }
    return { ok: true, dataUri: `data:${mime};base64,${merged.toString("base64")}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, fatal: false, error: msg };
  }
}

function extractAdminCandidate(headers: Record<string, string | undefined>): string {
  const xToken = (headers["x-admin-token"] || "").trim();
  if (xToken) return xToken;
  const auth = (headers["authorization"] || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : "";
}

/**
 * v2 stateless multimodal LLM generation endpoint for internal/first-party services.
 *
 *   POST /v2/admin/llm/generate
 *
 * Centralizes Gemini / multi-key LLM calls on `my-server-test.vercel.app` without
 * polluting widget chat threads or scattering API keys across downstream apps.
 */
export const v2LlmEndpoints = async (app: any) => {
  app.group("/v2", (app: any) => {
    app.post(
      "/admin/llm/generate",
      async ({
        headers,
        body,
        set,
      }: {
        headers: Record<string, string | undefined>;
        set: { status?: number | string };
        body: {
          system?: string;
          prompt: string;
          imageUrls?: string[];
          maxTokens?: number;
          temperature?: number;
          model?: string;
        };
      }) => {
        const genToken = process.env.LLM_GENERATE_TOKEN?.trim();
        const adminToken = process.env.ADMIN_TOKEN?.trim();
        if (!genToken && !adminToken) {
          set.status = 500;
          return {
            success: false,
            error: "neither LLM_GENERATE_TOKEN nor ADMIN_TOKEN is set on server",
          };
        }
        const token = extractAdminCandidate(headers);
        const authorized =
          (!!genToken && timingSafeMatch(token, genToken)) ||
          (!!adminToken && timingSafeMatch(token, adminToken));
        if (!authorized) {
          set.status = 401;
          return { success: false, error: "unauthorized" };
        }

        const prompt = typeof body?.prompt === "string" ? body.prompt.replace(/\x00+/g, "").trim() : "";
        if (!prompt) {
          set.status = 400;
          return { success: false, error: "prompt required" };
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
          set.status = 400;
          return { success: false, error: `prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters` };
        }

        const system =
          typeof body?.system === "string" ? body.system.replace(/\x00+/g, "").trim() : "";
        if (system.length > MAX_SYSTEM_CHARS) {
          set.status = 400;
          return { success: false, error: `system exceeds maximum length of ${MAX_SYSTEM_CHARS} characters` };
        }

        const rawImages = Array.isArray(body?.imageUrls) ? body.imageUrls : [];
        if (rawImages.length > MAX_IMAGES) {
          set.status = 400;
          return { success: false, error: `too many images (maximum ${MAX_IMAGES})` };
        }

        const modelOverride = typeof body?.model === "string" ? body.model.trim() : undefined;
        if (
          modelOverride &&
          (modelOverride.length > 120 || /[\s\x00-\x1f\x7f]/.test(modelOverride))
        ) {
          set.status = 400;
          return { success: false, error: "invalid model identifier" };
        }

        const maxTokens =
          typeof body?.maxTokens === "number" && Number.isFinite(body.maxTokens)
            ? Math.max(1, Math.min(4096, Math.floor(body.maxTokens)))
            : 1600;
        const temperature =
          typeof body?.temperature === "number" && Number.isFinite(body.temperature)
            ? Math.max(0, Math.min(2, body.temperature))
            : 0.4;

        const provider = createLLMProvider();
        if (!provider) {
          set.status = 503;
          return { success: false, error: "LLM provider is not configured on server" };
        }

        const resolvedParts: ChatContentPart[] = [];
        let loadedImages = 0;
        if (rawImages.length > 0) {
          const results = await Promise.all(
            rawImages.map((item) =>
              typeof item === "string"
                ? resolveImageDataUri(item)
                : Promise.resolve({ ok: false as const, fatal: true, error: "imageUrls items must be strings" }),
            ),
          );
          for (const res of results) {
            if (!res.ok) {
              if (res.fatal) {
                set.status = 400;
                return { success: false, error: res.error };
              }
              console.warn("[v2/admin/llm/generate] skipped unreachable image:", res.error);
              continue;
            }
            resolvedParts.push({ type: "image_url", image_url: { url: res.dataUri } });
            loadedImages++;
          }
        }

        const messages: ChatMessage[] = [];
        if (system) {
          messages.push({ role: "system", content: system });
        }
        if (resolvedParts.length > 0) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: prompt }, ...resolvedParts],
          });
        } else {
          messages.push({ role: "user", content: prompt });
        }

        try {
          const chunks: string[] = [];
          for await (const chunk of provider.stream(
            {
              messages,
              model: modelOverride || undefined,
              maxTokens,
              temperature,
            },
            AbortSignal.timeout(35_000),
          )) {
            chunks.push(chunk);
          }
          const text = chunks.join("").trim();
          if (!text) {
            set.status = 502;
            return { success: false, error: "LLM returned empty text" };
          }
          return {
            success: true,
            text,
            provider: provider.name,
            imagesUsed: loadedImages,
          };
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[v2/admin/llm/generate] failed:", message);
          const status =
            err?.status === 429 || err?.statusCode === 429
              ? 429
              : 502;
          set.status = status;
          return { success: false, error: message };
        }
      },
      {
        body: t.Object(
          {
            system: t.Optional(t.String({ description: "시스템 프롬프트 (선택)" })),
            prompt: t.String({ description: "사용자 프롬프트 (필수)" }),
            imageUrls: t.Optional(
              t.Array(t.String(), {
                description: "멀티모달 이미지 HTTPS URL 또는 base64 data URI 배열 (최대 5장)",
              }),
            ),
            maxTokens: t.Optional(t.Number({ description: "최대 출력 토큰 수 (기본 1600, 최대 4096)" })),
            temperature: t.Optional(t.Number({ description: "샘플링 온도 0~2 (기본 0.4)" })),
            model: t.Optional(t.String({ description: "모델 오버라이드 (생략 시 서버 LLM_MODEL 사용)" })),
          },
          {
            examples: [
              {
                system: "정중한 합니다체 전문가 작업 기록을 작성하십시오.",
                prompt: "메모: 광주시 경안동 4층 상가 외벽 코킹 작업",
                imageUrls: [],
                maxTokens: 1200,
              },
            ],
          },
        ),
        detail: {
          tags: ["API"],
          description:
            "공통 멀티모달 LLM 텍스트 생성 API (스레드 비저장). X-Admin-Token 헤더 필수 (LLM_GENERATE_TOKEN 또는 ADMIN_TOKEN).",
          parameters: [
            {
              name: "X-Admin-Token",
              in: "header",
              required: true,
              description: "인증 토큰 — 서버의 LLM_GENERATE_TOKEN 또는 ADMIN_TOKEN과 일치해야 합니다.",
              schema: { type: "string" },
            },
          ],
        },
      },
    );

    return app;
  });
};
