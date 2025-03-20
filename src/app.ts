import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import { healthzEndpoint } from "./endpoints/healthz";
import { cors } from "@elysiajs/cors";

export const createApp = async () => {
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
            title: "YouTube API Documentation",
            description: "API documentation for YouTube integration",
            version: "1.0.0",
          },
          tags: [
            { name: "YouTube", description: "YouTube integration endpoints" },
            { name: "Health", description: "Health check endpoints" },
          ],
        },
      }),
    );

  v1Endpoints(app);
  healthzEndpoint(app);

  app.listen(process.env.PORT ?? 3000);

  return app;
};
