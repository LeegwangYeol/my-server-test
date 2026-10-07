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

const toWebRequest = (req: IncomingMessage, res?: ServerResponse): Request => {
  const rawHost =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    req.headers.host ??
    "localhost";
  const hostStr = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  const host = (hostStr ?? "localhost").split(",")[0].trim() || "localhost";

  const rawProto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const protoStr = Array.isArray(rawProto) ? rawProto[0] : rawProto;
  const protocol = (protoStr ?? "https").split(",")[0].trim() || "https";

  const url = `${protocol}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  req.on("aborted", onAbort);
  req.on("close", () => {
    if (!req.complete) onAbort();
  });
  if (res && typeof res.on === "function") {
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });
  }

  return new Request(url, {
    method,
    headers,
    duplex: hasBody ? "half" : undefined,
    body: hasBody ? (req as any) : undefined,
    signal: controller.signal,
  } as RequestInit & { duplex?: "half" });
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
  try {
    const app = await getApp();
    const webReq = toWebRequest(req, res);
    const webRes: Response = await app.handle(webReq);
    await writeWebResponse(res, webRes, webReq.signal);
  } catch (error: any) {
    console.error("Serverless handler error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-content-type-options", "nosniff");
      const isProd =
        process.env.NODE_ENV === "production" ||
        process.env.VERCEL_ENV === "production";
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          message: isProd ? "Internal Server Error" : error?.message,
          stack: isProd ? undefined : error?.stack,
        }),
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
  }
}
