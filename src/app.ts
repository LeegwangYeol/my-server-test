import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import { v2WidgetEndpoints } from "./endpoints/v2/widget-endpoints";
import { v2MailEndpoints } from "./endpoints/v2/mail-endpoints";
import { v2SmsEndpoints } from "./endpoints/v2/sms-endpoints";
import { healthzEndpoint } from "./endpoints/healthz";
import { cors } from "@elysiajs/cors";

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB

export const createApp = async (serverless = false) => {
  const app = new Elysia({
    serve: {
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    },
  });

  app
    .onRequest(({ request, set }) => {
      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        const isUpload = request.headers
          .get("content-type")
          ?.includes("multipart/form-data");
        const limit = isUpload ? 2 * 1024 * 1024 : MAX_REQUEST_BODY_SIZE;
        if (!isNaN(size) && size > limit) {
          set.status = 413;
          return {
            success: false,
            error: `Payload Too Large: request body exceeds ${isUpload ? "2MB" : "1MB"} limit`,
          };
        }
      }
    })
    .onError(({ error, code, set }: any) => {
      if (
        code === "PARSE" &&
        (error?.message?.includes("PAYLOAD_TOO_LARGE") ||
          (error as any)?.cause?.message?.includes("PAYLOAD_TOO_LARGE") ||
          String(error).includes("PAYLOAD_TOO_LARGE"))
      ) {
        set.status = 413;
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
      if (contentType === "application/json") {
        const text = await request.text();
        if (text.length > MAX_REQUEST_BODY_SIZE) {
          throw new Error("PAYLOAD_TOO_LARGE");
        }
        return JSON.parse(text);
      }
    })
    .use(
      cors({
        origin: true,
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
