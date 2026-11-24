import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import {
  v2WidgetEndpoints,
  timingSafeMatch,
} from "./endpoints/v2/widget-endpoints";
import { v2MailEndpoints } from "./endpoints/v2/mail-endpoints";
import { v2SmsEndpoints } from "./endpoints/v2/sms-endpoints";
import { v2LlmEndpoints } from "./endpoints/v2/llm-endpoints";
import { healthzEndpoint } from "./endpoints/healthz";

import {
  checkRateLimit,
  resolvePolicy,
  extractClientIp,
} from "../lib/rate-limit";

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB
const MAX_UPLOAD_BODY_SIZE = 2 * 1024 * 1024; // 2MB

const ALLOWED_CORS_METHODS = "GET, POST, OPTIONS";
const ALLOWED_CORS_HEADERS =
  "content-type, authorization, x-admin-token, idempotency-key, x-idempotency-key, accept, x-requested-with, x-test-rate-limit";
const EXPOSED_CORS_HEADERS =
  "retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";

/**
 * Validates and normalizes an HTTP Origin header per WHATWG Fetch / OWASP WSTG-CLNT-07.
 * Blocks `Origin: null` (sandboxed iframe / data: URI reflection), non-HTTP(S) schemes,
 * embedded credentials, path/query/hash smuggling, and control characters.
 */
export function sanitizeCorsOrigin(rawOrigin?: string | null): string | null {
  if (!rawOrigin) return null;
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.length > 512) {
    return null;
  }
  if (/[\s\x00-\x1f\x7f\\]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

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

/**
 * Single-pass RFC 8259 scanner inspecting root-level JSON object properties
 * (including Unicode-escaped variants like `\u006dessage`) after `JSON.parse` succeeds.
 * Tracks total root property count and preserves all values for duplicated root keys
 * so duplicate-key overwrites (`{"browserInfo":"<2500>","browserInfo":"ok"}`,
 * `{"junk":"<2500>","junk":"1"}`, `{"message":"<50KB>","message":"hi"}`,
 * `{"widgetId":"unreg","widgetId":"reg"}`) cannot bypass 413/403 guards.
 */
function inspectRootJsonObject(text: string): {
  rootPropCount: number;
  protoPayloadChars: number;
  duplicateValues: Map<string, unknown[]>;
} {
  const firstSlice = new Map<string, [number, number]>();
  const duplicateValues = new Map<string, unknown[]>();
  let rootPropCount = 0;
  let protoPayloadChars = 0;
  const len = text.length;
  let i = 0;

  const skipWs = () => {
    while (i < len) {
      const ws = text.charCodeAt(i);
      if (ws === 32 || ws === 9 || ws === 10 || ws === 13) i++;
      else break;
    }
  };

  const skipJsonString = () => {
    i++; // skip opening '"'
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 92) {
        i += 2;
        continue;
      }
      if (c === 34) {
        i++;
        return;
      }
      i++;
    }
  };

  skipWs();
  if (i >= len || text.charCodeAt(i) !== 123) {
    return { rootPropCount: 0, protoPayloadChars: 0, duplicateValues };
  }
  i++; // enter root '{'

  while (i < len) {
    skipWs();
    if (i >= len) break;
    const ch = text.charCodeAt(i);
    if (ch === 125) break; // closing root '}'
    if (ch === 44) {
      i++;
      continue;
    }
    if (ch !== 34) break;

    const keyStart = i;
    skipJsonString();
    const keyEnd = i;
    rootPropCount++;

    skipWs();
    if (i >= len || text.charCodeAt(i) !== 58) break;
    i++; // skip ':'
    skipWs();

    const valStart = i;
    let nested = 0;
    while (i < len) {
      const vc = text.charCodeAt(i);
      if (vc === 34) {
        skipJsonString();
        continue;
      }
      if (vc === 123 || vc === 91) {
        nested++;
        i++;
        continue;
      }
      if (vc === 125 || vc === 93) {
        if (nested === 0 && vc === 125) break;
        nested--;
        i++;
        continue;
      }
      if (nested === 0 && vc === 44) break;
      i++;
    }
    const valEnd = i;

    let keyName: unknown;
    try {
      keyName = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      continue;
    }
    if (typeof keyName !== "string") continue;

    if (
      keyName === "__proto__" ||
      keyName === "constructor" ||
      keyName === "prototype"
    ) {
      protoPayloadChars += keyEnd - keyStart + (valEnd - valStart);
    }

    const prevSlice = firstSlice.get(keyName);
    if (!prevSlice) {
      firstSlice.set(keyName, [valStart, valEnd]);
    } else {
      let arr = duplicateValues.get(keyName);
      if (!arr) {
        try {
          arr = [JSON.parse(text.slice(prevSlice[0], prevSlice[1]))];
        } catch {
          arr = [null];
        }
        duplicateValues.set(keyName, arr);
      }
      try {
        arr.push(JSON.parse(text.slice(valStart, valEnd)));
      } catch {
        arr.push(null);
      }
    }
  }

  return { rootPropCount, protoPayloadChars, duplicateValues };
}

export const createApp = async (serverless = false) => {
  const app = new Elysia({
    serve: {
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    },
  });

  app
    .onRequest(({ request, set }) => {
      set.headers = set.headers || {};
      set.headers["x-content-type-options"] = "nosniff";

      const safeOrigin = sanitizeCorsOrigin(request.headers.get("origin"));
      const applyCorsHeaders = () => {
        set.headers = set.headers || {};
        set.headers["x-content-type-options"] = "nosniff";
        if (safeOrigin) {
          set.headers["access-control-allow-origin"] = safeOrigin;
          set.headers["access-control-allow-credentials"] = "true";
          set.headers["access-control-expose-headers"] = EXPOSED_CORS_HEADERS;
          set.headers["vary"] = "Origin";
        }
      };

      // Attach validated CORS headers for all legitimate cross-origin requests
      applyCorsHeaders();

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

      // Handle CORS preflight (bypass rate limit; never echo internal proxy headers)
      if (request.method === "OPTIONS") {
        const preflightHeaders = new Headers({
          "x-content-type-options": "nosniff",
        });
        if (safeOrigin) {
          preflightHeaders.set("access-control-allow-origin", safeOrigin);
          preflightHeaders.set("access-control-allow-credentials", "true");
          preflightHeaders.set("access-control-allow-methods", ALLOWED_CORS_METHODS);
          preflightHeaders.set("access-control-allow-headers", ALLOWED_CORS_HEADERS);
          preflightHeaders.set("access-control-max-age", "600");
          preflightHeaders.set("vary", "Origin");
        } else if (request.headers.has("origin")) {
          preflightHeaders.set("vary", "Origin");
        }
        return new Response(null, { status: 204, headers: preflightHeaders });
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
        set.headers["access-control-expose-headers"] = EXPOSED_CORS_HEADERS;
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
      set.headers["access-control-expose-headers"] = EXPOSED_CORS_HEADERS;
    })
    .onError(({ request, error, code, set }: any) => {
      const safeOrigin = sanitizeCorsOrigin(request?.headers?.get?.("origin"));
      const attachOriginCors = () => {
        set.headers = set.headers || {};
        set.headers["x-content-type-options"] = "nosniff";
        if (safeOrigin) {
          set.headers["access-control-allow-origin"] = safeOrigin;
          set.headers["access-control-allow-credentials"] = "true";
          set.headers["access-control-expose-headers"] = EXPOSED_CORS_HEADERS;
          set.headers["vary"] = "Origin";
        }
      };

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
        attachOriginCors();
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
          const rawBearer = (request?.headers?.get?.("authorization") || "").trim();
          const bearerMatch = /^Bearer\s+(.+)$/i.exec(rawBearer);
          const token = (request?.headers?.get?.("x-admin-token") || "").trim() || (bearerMatch ? bearerMatch[1].trim() : "");

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
          } else if (errPath === "/v2/admin/llm/generate") {
            const genToken = process.env.LLM_GENERATE_TOKEN?.trim();
            const adminToken = process.env.ADMIN_TOKEN?.trim();
            if (!genToken && !adminToken) {
              set.status = 500;
              attachOriginCors();
              return {
                success: false,
                error: "neither LLM_GENERATE_TOKEN nor ADMIN_TOKEN is set on server",
              };
            }
            const ok =
              (!!genToken && timingSafeMatch(token, genToken)) ||
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
        attachOriginCors();
        return;
      }

      if (code === "NOT_FOUND") {
        attachOriginCors();
        return;
      }

      const isProd =
        process.env.NODE_ENV === "production" ||
        process.env.VERCEL_ENV === "production";

      set.status =
        typeof set.status === "number" && set.status >= 400
          ? set.status
          : 500;
      attachOriginCors();
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
            if (
              key === "__proto__" ||
              key === "constructor" ||
              key === "prototype"
            ) {
              return;
            }
            if (Object.prototype.hasOwnProperty.call(parsed, key)) {
              const prev = parsed[key];
              parsed[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
            } else {
              parsed[key] = value;
            }
          });
          return parsed;
        }
        // Non-upload routes must never buffer >1MB multipart streams
        const mpText = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        const normMpPath = normalizePathname(pathname);
        if (
          mpText.length > 0 &&
          (normMpPath === "/v2/ask" ||
            normMpPath === "/v2/widget/create-thread" ||
            normMpPath === "/v2/widget/view")
        ) {
          return mpText;
        }
        return {};
      }

      if (mediaType === "application/json" || mediaType.endsWith("+json")) {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        if (!text) return {};
        const parsed = JSON.parse(text);
        let reqPath = "/";
        try {
          reqPath = normalizePathname(
            new URL(request.url, "http://localhost").pathname,
          );
        } catch {
          reqPath = "/";
        }
        const isWidgetPublicRoute =
          reqPath === "/v2/ask" ||
          reqPath === "/v2/widget/create-thread" ||
          reqPath === "/v2/widget/view";

        if (parsed === null) {
          const nullLimit = reqPath === "/v2/widget/view" ? 2000 : 4000;
          if (isWidgetPublicRoute && text.length > nullLimit) {
            return text;
          }
          return {};
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
          if (isWidgetPublicRoute) {
            return parsed;
          }
          return {};
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
          if (reqPath === "/v2/widget/view" || reqPath === "/v2/widget/create-thread") {
            let protoRaw = "";
            try {
              const pv = (parsed as Record<string, unknown>)["__proto__"];
              protoRaw = typeof pv === "string" ? pv : (JSON.stringify(pv) ?? "");
            } catch {
              throw new Error("PAYLOAD_TOO_LARGE");
            }
            if ("__proto__".length + protoRaw.length > 2000) {
              throw new Error("PAYLOAD_TOO_LARGE");
            }
          }
          delete (parsed as Record<string, unknown>)["__proto__"];
        }
        if (isWidgetPublicRoute) {
          const { rootPropCount, protoPayloadChars, duplicateValues } =
            inspectRootJsonObject(text);
          const maxRootProps = reqPath === "/v2/ask" ? 32 : 12;
          if (
            rootPropCount > maxRootProps ||
            ((reqPath === "/v2/widget/view" ||
              reqPath === "/v2/widget/create-thread") &&
              protoPayloadChars > 2000)
          ) {
            throw new Error("PAYLOAD_TOO_LARGE");
          }
          if (duplicateValues.size > 0) {
            const dupCharLimit = reqPath === "/v2/widget/view" ? 2000 : 4000;
            if (text.length > dupCharLimit) {
              throw new Error("PAYLOAD_TOO_LARGE");
            }
            const rec = parsed as Record<string, unknown>;
            for (const [dupKey, vals] of duplicateValues.entries()) {
              if (
                dupKey === "__proto__" ||
                dupKey === "constructor" ||
                dupKey === "prototype"
              ) {
                if (reqPath === "/v2/widget/view" || reqPath === "/v2/widget/create-thread") {
                  let rawDanger = "";
                  try {
                    rawDanger = JSON.stringify(vals) ?? "";
                  } catch {
                    throw new Error("PAYLOAD_TOO_LARGE");
                  }
                  if (dupKey.length + rawDanger.length > 2000) {
                    throw new Error("PAYLOAD_TOO_LARGE");
                  }
                }
                continue;
              }
              rec[dupKey] = vals;
            }
          }
        }
        return parsed;
      }

      if (mediaType === "text/plain") {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        if (!text) return undefined;
        return text;
      }

      if (mediaType === "application/x-www-form-urlencoded") {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        let reqFormPath = "/";
        try {
          reqFormPath = normalizePathname(
            new URL(request.url, "http://localhost").pathname,
          );
        } catch {
          reqFormPath = "/";
        }
        const isPublicWidgetForm =
          reqFormPath === "/v2/ask" ||
          reqFormPath === "/v2/widget/create-thread" ||
          reqFormPath === "/v2/widget/view";
        const maxFormPairs = reqFormPath === "/v2/ask" ? 32 : 12;
        let pairCount = 0;
        let strippedDangerChars = 0;
        const safeObj: Record<string, string | string[]> = {};
        for (const [k, v] of new URLSearchParams(text)) {
          pairCount++;
          if (isPublicWidgetForm && pairCount > maxFormPairs) {
            throw new Error("PAYLOAD_TOO_LARGE");
          }
          if (k === "__proto__" || k === "constructor" || k === "prototype") {
            if (isPublicWidgetForm) {
              strippedDangerChars += k.length + v.length;
              const dangerLimit = reqFormPath === "/v2/ask" ? 4000 : 2000;
              if (strippedDangerChars > dangerLimit) {
                throw new Error("PAYLOAD_TOO_LARGE");
              }
            }
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(safeObj, k)) {
            const prev = safeObj[k];
            safeObj[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
          } else {
            safeObj[k] = v;
          }
        }
        return safeObj;
      }

      if (request.body) {
        const text = await readBoundedBodyText(request, MAX_REQUEST_BODY_SIZE);
        if (!text) return undefined;
        return text;
      }
    })
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
  await v2LlmEndpoints(app);
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
