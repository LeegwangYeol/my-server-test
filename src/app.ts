import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import { healthzEndpoint } from "./endpoints/healthz";
import { cors } from "@elysiajs/cors";

export const createApp = async (serverless = false) => {
  const app = new Elysia();

  app
    .onAfterHandle(({ request, set }) => {
      // * Only process CORS requests
      if (request.method !== "OPTIONS") return;

      const allowHeader = set.headers["Access-Control-Allow-Headers"];
      if (allowHeader === "*") {
        set.headers["Access-Control-Allow-Headers"] =
          request.headers.get("Access-Control-Request-Headers") ?? "";
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

  v1Endpoints(app as any);
  healthzEndpoint(app as any);

  // 서버리스 모드가 아닌 경우에만 listen 호출
  if (!serverless) {
    app.listen(process.env.PORT ?? 3000);
  }

  return app;
};
