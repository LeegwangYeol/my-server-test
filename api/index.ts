import type { IncomingMessage, ServerResponse } from "node:http";

let appPromise: Promise<any> | null = null;

const getApp = () => {
  if (!appPromise) {
    appPromise = (async () => {
      const { createApp } = await import("../src/app");
      return createApp(true);
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
};

const toWebRequest = (req: IncomingMessage): Request => {
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

  return new Request(url, {
    method,
    headers,
    // @ts-ignore - duplex is required by Node when sending a stream body
    duplex: hasBody ? "half" : undefined,
    body: hasBody ? (req as any) : undefined,
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

  const reader = webRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const app = await getApp();
    const webReq = toWebRequest(req);
    const webRes: Response = await app.handle(webReq);
    await writeWebResponse(res, webRes);
  } catch (error: any) {
    console.error("Serverless handler error:", error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "Internal Server Error",
        message: error?.message ?? String(error),
        stack: error?.stack,
      }),
    );
  }
}
