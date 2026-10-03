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
  const host = req.headers.host ?? "localhost";
  const protocol =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
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
    // @ts-ignore - duplex is required by Node when sending a stream body
    duplex: hasBody ? "half" : undefined,
    body: hasBody ? (req as any) : undefined,
    signal: controller.signal,
  });
};

const writeWebResponse = async (
  res: ServerResponse,
  webRes: Response,
): Promise<void> => {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
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
      res.write(value);
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
    await writeWebResponse(res, webRes);
  } catch (error: any) {
    console.error("Serverless handler error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          message: error?.message ?? String(error),
          stack: error?.stack,
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
