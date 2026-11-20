import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app";

let appPromise: ReturnType<typeof createApp> | null = null;

const getApp = () => {
  if (!appPromise) {
    appPromise = createApp(true).catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
};

const SAFE_HOST_RE =
  /^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/;

export function sanitizeHost(raw?: string | string[]): string {
  const str = Array.isArray(raw) ? raw[0] : raw;
  const candidate = (str ?? "").split(",")[0].trim();
  if (!candidate || candidate.length > 255 || !SAFE_HOST_RE.test(candidate)) {
    return "localhost";
  }
  try {
    const parsed = new URL(`http://${candidate}/`);
    if (
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return "localhost";
    }
    if (parsed.port) {
      const portNum = Number(parsed.port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return "localhost";
      }
    }
    return parsed.host;
  } catch {
    return "localhost";
  }
}

export function sanitizeProtocol(raw?: string | string[]): "http" | "https" {
  const str = Array.isArray(raw) ? raw[0] : raw;
  const candidate = (str ?? "").split(",")[0].trim().toLowerCase();
  return candidate === "http" ? "http" : "https";
}

export function sanitizeRequestPath(
  rawUrl?: string,
  baseOrigin = "https://localhost",
): string {
  if (!rawUrl) return "/";
  let p = rawUrl.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!p) return "/";
  if (!p.startsWith("/") && !p.startsWith("\\")) {
    try {
      const parsed = new URL(p);
      p = `${parsed.pathname || "/"}${parsed.search}`;
    } catch {
      p = `/${p}`;
    }
  }
  // Collapse leading slashes/backslashes so `//evil.com` or `/\evil.com` cannot override host
  const qIdx = p.indexOf("?");
  if (qIdx === -1) {
    p = p.replace(/^[\/\\]+/, "/");
  } else {
    p = p.slice(0, qIdx).replace(/^[\/\\]+/, "/") + p.slice(qIdx);
  }
  try {
    const resolved = new URL(p || "/", baseOrigin);
    if (resolved.origin !== baseOrigin) {
      return "/";
    }
    return `${resolved.pathname || "/"}${resolved.search}`;
  } catch {
    return "/";
  }
}

const toWebRequest = (
  req: IncomingMessage,
  res?: ServerResponse,
): { webReq: Request; cleanup: () => void } => {
  const host = sanitizeHost(
    (req.headers["x-forwarded-host"] as string | string[] | undefined) ??
      req.headers.host,
  );
  const protocol = sanitizeProtocol(
    req.headers["x-forwarded-proto"] as string | string[] | undefined,
  );
  const baseOrigin = `${protocol}://${host}`;
  const safePath = sanitizeRequestPath(req.url, baseOrigin);
  const url = `${baseOrigin}${safePath}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(":")) continue;
    try {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    } catch {
      if (key.toLowerCase() === "content-length") {
        const badHdrErr: Error & { statusCode?: number } = new Error(
          "Bad Request: invalid Content-Length header",
        );
        badHdrErr.statusCode = 400;
        throw badHdrErr;
      }
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onReqClose = () => {
    if (!req.complete) onAbort();
  };
  const onResClose = () => {
    if (res && !res.writableEnded) {
      controller.abort();
    }
  };

  if (typeof req.on === "function") {
    req.on("aborted", onAbort);
    req.on("close", onReqClose);
  }
  if (res && typeof res.on === "function") {
    res.on("close", onResClose);
  }

  const cleanup = () => {
    if (typeof req.off === "function") {
      req.off("aborted", onAbort);
      req.off("close", onReqClose);
    }
    if (res && typeof res.off === "function") {
      res.off("close", onResClose);
    }
  };

  const webReq = new Request(url, {
    method,
    headers,
    duplex: hasBody ? "half" : undefined,
    body: hasBody ? (req as any) : undefined,
    signal: controller.signal,
  } as RequestInit & { duplex?: "half" });

  return { webReq, cleanup };
};

const writeWebResponse = async (
  res: ServerResponse,
  webRes: Response,
  signal?: AbortSignal,
): Promise<void> => {
  res.statusCode = webRes.status;

  // Preserve multiple Set-Cookie headers without clobbering
  if (typeof (webRes.headers as any).getSetCookie === "function") {
    const cookies = (webRes.headers as any).getSetCookie();
    if (Array.isArray(cookies) && cookies.length > 0) {
      res.setHeader("set-cookie", cookies);
    }
  }

  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") {
      res.setHeader(key, value);
    } else if (typeof (webRes.headers as any).getSetCookie !== "function") {
      // Fallback for environments without getSetCookie
      if (typeof (res as any).appendHeader === "function") {
        (res as any).appendHeader(key, value);
      } else {
        const prev = res.getHeader(key);
        if (prev) {
          const arr = Array.isArray(prev) ? [...prev, value] : [String(prev), value];
          res.setHeader(key, arr);
        } else {
          res.setHeader(key, value);
        }
      }
    }
  });

  if (!webRes.body) {
    res.end();
    return;
  }

  // Prevent unhandled error event on abrupt socket reset
  if (typeof res.on === "function") {
    res.on("error", () => {});
  }

  const reader = webRes.body.getReader();
  const onClose = () => {
    reader.cancel().catch(() => {});
  };
  if (typeof res.on === "function") {
    res.on("close", onClose);
  }

  try {
    while (true) {
      if (res.destroyed || res.writableEnded) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed || res.writableEnded) break;
      const canWrite = res.write(value);
      if (!canWrite && !res.destroyed && !res.writableEnded) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onCloseDrain = () => {
            cleanup();
            resolve();
          };
          const onSignalAbort = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            if (typeof res.off === "function") {
              res.off("drain", onDrain);
              res.off("close", onCloseDrain);
            }
            if (signal) {
              signal.removeEventListener("abort", onSignalAbort);
            }
          };
          if (signal?.aborted) {
            resolve();
            return;
          }
          if (signal) {
            signal.addEventListener("abort", onSignalAbort, { once: true });
          }
          if (typeof res.on === "function") {
            res.once("drain", onDrain);
            res.once("close", onCloseDrain);
          } else {
            resolve();
          }
        });
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch (err: any) {
    if (err?.code !== "ERR_STREAM_DESTROYED" && !res.destroyed) {
      throw err;
    }
  } finally {
    void reader.cancel().catch(() => {});
    if (typeof res.off === "function") {
      res.off("close", onClose);
    }
  }
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let cleanupListeners: (() => void) | undefined;
  try {
    const app = await getApp();
    const { webReq, cleanup } = toWebRequest(req, res);
    cleanupListeners = cleanup;
    const webRes: Response = await app.handle(webReq);
    await writeWebResponse(res, webRes, webReq.signal);
  } catch (error: any) {
    console.error("Serverless handler error:", error);
    if (!res.headersSent) {
      const status =
        typeof error?.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 600
          ? error.statusCode
          : 500;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-content-type-options", "nosniff");
      const isProd =
        process.env.NODE_ENV === "production" ||
        process.env.VERCEL_ENV === "production";
      res.end(
        JSON.stringify(
          status === 400
            ? {
                success: false,
                error: error?.message || "Bad Request",
              }
            : {
                error: "Internal Server Error",
                message: isProd ? "Internal Server Error" : error?.message,
                stack: isProd ? undefined : error?.stack,
              },
        ),
      );
    } else {
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* ignore already closed socket */
        }
      }
    }
  } finally {
    cleanupListeners?.();
  }
}
