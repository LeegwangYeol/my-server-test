import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import { v2WidgetEndpoints } from "./endpoints/v2/widget-endpoints";
import { v2MailEndpoints } from "./endpoints/v2/mail-endpoints";
import { v2SmsEndpoints } from "./endpoints/v2/sms-endpoints";
import { healthzEndpoint } from "./endpoints/healthz";
import { cors } from "@elysiajs/cors";

import {
  checkRateLimit,
  resolvePolicy,
  extractClientIp,
} from "../lib/rate-limit";

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB
const MAX_UPLOAD_BODY_SIZE = 2 * 1024 * 1024; // 2MB

function normalizePathname(rawPathname: string): string {
  let p = (rawPathname || "/").trim().replace(/\/+/g, "/");
  if (p.toLowerCase().startsWith("/api/")) {
    p = p.slice(4);
  }
  if (p.length > 1) {
    p = p.replace(/\/+$/, "");
  }
  return p;
}

function extractMediaType(rawContentType?: string | null): string {
  return String(rawContentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

async function readBoundedBodyText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("PAYLOAD_TOO_LARGE").catch(() => {});
          throw new Error("PAYLOAD_TOO_LARGE");
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
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder("utf-8").decode(chunks[0]);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

export const createApp = async (serverless = false) => {
  const app = new Elysia({
    serve: {
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    },
  });

  app
    .onRequest(({ request, set }) => {
      const origin = request.headers.get("origin");
      const applyCorsHeaders = () => {
        if (origin) {
          set.headers = set.headers || {};
          set.headers["access-control-allow-origin"] = origin;
          set.headers["access-control-allow-credentials"] = "true";
          set.headers["access-control-expose-headers"] =
            "retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";
          set.headers["vary"] = "Origin";
        }
      };

      let pathname = "/";
      try {
        const url = new URL(request.url, "http://localhost");
        pathname = url.pathname;
      } catch {
        pathname = "/";
      }
      const normPath = normalizePathname(pathname);
      const mediaType = extractMediaType(request.headers.get("content-type"));
      const isUpload =
        mediaType === "multipart/form-data" &&
        normPath === "/v2/admin/widgets/upload-icon";

      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        const limit = isUpload ? MAX_UPLOAD_BODY_SIZE : MAX_REQUEST_BODY_SIZE;
        if (!isNaN(size) && size > limit) {
          set.status = 413;
          applyCorsHeaders();
          return {
            success: false,
            error: `Payload Too Large: request body exceeds ${isUpload ? "2MB" : "1MB"} limit`,
          };
        }
      }

      // Bypass rate limit for CORS preflight
      if (request.method === "OPTIONS") {
        return;
      }

      // Endpoint Rate Limiting
      const policy = resolvePolicy(pathname, request.method);
      const clientIp = extractClientIp(request);
      const rateLimitKey = `${clientIp}:${policy.tier}`;

      const rateLimitRes = checkRateLimit(
        rateLimitKey,
        policy.limit,
        policy.windowMs,
        request,
      );

      if (!rateLimitRes.allowed) {
        set.status = 429;
        const retryAfterSec = Math.max(1, Math.ceil(rateLimitRes.resetMs / 1000));
        set.headers = set.headers || {};
        set.headers["retry-after"] = String(retryAfterSec);
        set.headers["x-ratelimit-limit"] = String(policy.limit);
        set.headers["x-ratelimit-remaining"] = "0";
        set.headers["x-ratelimit-reset"] = String(rateLimitRes.resetEpochSec);
        applyCorsHeaders();
        return {
          success: false,
          error: "Too Many Requests",
          message: `Rate limit exceeded for tier '${policy.tier}'. Please retry after ${retryAfterSec} seconds.`,
          retryAfter: retryAfterSec,
        };
      }

      set.headers = set.headers || {};
      set.headers["x-ratelimit-limit"] = String(policy.limit);
      set.headers["x-ratelimit-remaining"] = String(rateLimitRes.remaining);
      set.headers["x-ratelimit-reset"] = String(rateLimitRes.resetEpochSec);
      set.headers["access-control-expose-headers"] =
        "retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";
    })
    .onError(({ request, error, code, set }: any) => {
      if (
        (code === "PARSE" || error?.message === "PAYLOAD_TOO_LARGE") &&
        (error?.message?.includes("PAYLOAD_TOO_LARGE") ||
          (error as any)?.cause?.message?.includes("PAYLOAD_TOO_LARGE") ||
          String(error).includes("PAYLOAD_TOO_LARGE"))
      ) {
        set.status = 413;
        const origin = request?.headers?.get?.("origin");
        if (origin) {
          set.headers = set.headers || {};
          set.headers["access-control-allow-origin"] = origin;
          set.headers["access-control-allow-credentials"] = "true";
          set.headers["access-control-expose-headers"] =
            "retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";
          set.headers["vary"] = "Origin";
        }
        return {
          success: false,
          error: "Payload Too Large: request body exceeds 1MB limit",
        };
      }

      if (code === "NOT_FOUND" || code === "VALIDATION" || code === "PARSE") {
        return;
      }

      const isProd =
        process.env.NODE_ENV === "production" ||
        process.env.VERCEL_ENV === "production";

      set.status =
        typeof set.status === "number" && set.status >= 400
          ? set.status
          : 500;
      return {
        success: false,
        error: isProd
          ? "Internal Server Error"
          : (error?.message ?? "Internal Server Error"),
      };
    })
    .onParse(async ({ request, contentType }) => {
      const mediaType = extractMediaType(
        typeof contentType === "string" && contentType.length > 0
          ? contentType
          : request.headers.get("content-type"),
      );

      if (mediaType === "multipart/form-data") {
        let pathname = "/";
        try {
          pathname = new URL(request.url, "http://localhost").pathname;
        } catch {
          pathname = "/";
        }
        if (normalizePathname(pathname) === "/v2/admin/widgets/upload-icon") {
          return;
        }
        // Non-upload routes must never buffer >1MB multipart streams
        await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        return {};
      }

      if (mediaType === "application/json" || mediaType.endsWith("+json")) {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        if (!text) return {};
        return JSON.parse(text);
      }

      if (mediaType === "text/plain") {
        return await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
      }

      if (mediaType === "application/x-www-form-urlencoded") {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        return Object.fromEntries(new URLSearchParams(text));
      }

      if (request.body) {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        if (!text) return undefined;
        return text;
      }
    })
    .use(
      cors({
        origin: true,
        exposeHeaders: [
          "retry-after",
          "x-ratelimit-limit",
          "x-ratelimit-remaining",
          "x-ratelimit-reset",
        ],
      }),
    )
    .use(
      swagger({
        path: "/",
        scalarCDN:
          "https://unpkg.com/@scalar/api-reference@1.25.52/dist/browser/standalone.js",
        documentation: {
          info: {
            title: "API Documentation",
            description: "API documentation",
            version: "1.0.0",
          },
          tags: [
            { name: "API", description: "API endpoints" },
            { name: "Health", description: "Health check endpoints" },
          ],
        },
      }),
    );

  await v1Endpoints(app);
  await v2WidgetEndpoints(app);
  await v2MailEndpoints(app);
  await v2SmsEndpoints(app);
  await healthzEndpoint(app);

  // Platform sanity stub for local parity with Vercel api/hello.js
  app.get("/api/hello", ({ request }) => ({
    ok: true,
    message: "hello from vercel",
    ts: new Date().toISOString(),
    url: request.url,
    method: request.method,
  }));

  // Recompile router so all asynchronously mounted routes are indexed
  app.compile();

  // 서버리스 모드가 아닌 경우에만 listen 호출 및 graceful shutdown 리스너 등록
  if (!serverless) {
    app.listen(process.env.PORT ?? 3000);

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      try {
        await app.stop();
      } catch (err) {
        console.error("Error during graceful shutdown:", err);
      }
      process.exit(0);
    };

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
  }

  return app;
};
