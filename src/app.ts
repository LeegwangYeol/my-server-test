import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import {
  v2WidgetEndpoints,
  timingSafeMatch,
} from "./endpoints/v2/widget-endpoints";
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

async function readBoundedBodyBytes(
  request: Request,
  maxBytes: number,
  errToken = "PAYLOAD_TOO_LARGE",
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
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
          await reader.cancel(errToken).catch(() => {});
          throw new Error(errToken);
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
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readBoundedBodyText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const bytes = await readBoundedBodyBytes(request, maxBytes, "PAYLOAD_TOO_LARGE");
  if (bytes.byteLength === 0) return "";
  return new TextDecoder("utf-8").decode(bytes);
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
      if (contentLength !== null) {
        const limit = isUpload ? MAX_UPLOAD_BODY_SIZE : MAX_REQUEST_BODY_SIZE;
        const parts = contentLength
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
          set.status = 400;
          applyCorsHeaders();
          return {
            success: false,
            error: "Bad Request: invalid Content-Length header",
          };
        }
        const sizes = parts.map((p) => Number(p));
        if (sizes.some((sz) => !Number.isSafeInteger(sz) || sz > limit)) {
          set.status = 413;
          applyCorsHeaders();
          return {
            success: false,
            error: `Payload Too Large: request body exceeds ${isUpload ? "2MB" : "1MB"} limit`,
          };
        }
        if (new Set(sizes).size > 1) {
          set.status = 400;
          applyCorsHeaders();
          return {
            success: false,
            error: "Bad Request: conflicting Content-Length header values",
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
      const errStr = [
        error?.message,
        (error as any)?.cause?.message,
        String(error),
      ]
        .filter(Boolean)
        .join(" ");

      if (
        (code === "PARSE" || errStr.includes("PAYLOAD_TOO_LARGE")) &&
        errStr.includes("PAYLOAD_TOO_LARGE")
      ) {
        const is2Mb = errStr.includes("PAYLOAD_TOO_LARGE_2MB");
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
          error: `Payload Too Large: request body exceeds ${is2Mb ? "2MB" : "1MB"} limit`,
        };
      }

      if (code === "VALIDATION" || code === "PARSE") {
        let errPath = "/";
        try {
          errPath = normalizePathname(
            new URL(request?.url ?? "/", "http://localhost").pathname,
          );
        } catch {
          errPath = "/";
        }
        if (errPath.startsWith("/v2/admin/")) {
          const token = (request?.headers?.get?.("x-admin-token") || "").trim();
          const attachOriginCors = () => {
            const origin = request?.headers?.get?.("origin");
            if (origin) {
              set.headers = set.headers || {};
              set.headers["access-control-allow-origin"] = origin;
              set.headers["access-control-allow-credentials"] = "true";
              set.headers["access-control-expose-headers"] =
                "retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";
              set.headers["vary"] = "Origin";
            }
          };

          if (errPath === "/v2/admin/mail/send") {
            const mailToken = process.env.MAIL_SEND_TOKEN?.trim();
            const adminToken = process.env.ADMIN_TOKEN?.trim();
            if (!mailToken && !adminToken) {
              set.status = 500;
              attachOriginCors();
              return {
                success: false,
                error: "neither MAIL_SEND_TOKEN nor ADMIN_TOKEN is set on server",
              };
            }
            const ok =
              (!!mailToken && timingSafeMatch(token, mailToken)) ||
              (!!adminToken && timingSafeMatch(token, adminToken));
            if (!ok) {
              set.status = 401;
              attachOriginCors();
              return { success: false, error: "unauthorized" };
            }
          } else {
            const adminToken = process.env.ADMIN_TOKEN?.trim();
            if (!adminToken) {
              set.status = 500;
              attachOriginCors();
              return {
                success: false,
                error: "ADMIN_TOKEN env var not set on server",
              };
            }
            if (!timingSafeMatch(token, adminToken)) {
              set.status = 401;
              attachOriginCors();
              return { success: false, error: "unauthorized" };
            }
          }
        }
        return;
      }

      if (code === "NOT_FOUND") {
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
          const rawCt =
            request.headers.get("content-type") || "multipart/form-data";
          const bytes = await readBoundedBodyBytes(
            request,
            MAX_UPLOAD_BODY_SIZE,
            "PAYLOAD_TOO_LARGE_2MB",
          );
          if (bytes.byteLength === 0) return {};
          const adminToken = process.env.ADMIN_TOKEN?.trim();
          const reqToken = (request.headers.get("x-admin-token") || "").trim();
          if (!adminToken || !timingSafeMatch(reqToken, adminToken)) {
            return {};
          }
          const fd = await new Response(bytes as unknown as BodyInit, {
            headers: { "content-type": rawCt },
          }).formData();
          const parsed: Record<string, unknown> = {};
          fd.forEach((value, key) => {
            if (key in parsed) {
              const prev = parsed[key];
              parsed[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
            } else {
              parsed[key] = value;
            }
          });
          return parsed;
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
