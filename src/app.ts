import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { v1Endpoints } from "./endpoints/v1/v1-endpoints";
import { v2WidgetEndpoints } from "./endpoints/v2/widget-endpoints";
import { v2MailEndpoints } from "./endpoints/v2/mail-endpoints";
import { v2SmsEndpoints } from "./endpoints/v2/sms-endpoints";
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

  // 타입 체크 비활성화
  // @ts-ignore
  v1Endpoints(app);
  // @ts-ignore
  v2WidgetEndpoints(app);
  // @ts-ignore
  v2MailEndpoints(app);
  // @ts-ignore
  v2SmsEndpoints(app);
  // @ts-ignore
  healthzEndpoint(app);

  // 서버리스 모드가 아닌 경우에만 listen 호출
  if (!serverless) {
    app.listen(process.env.PORT ?? 3000);
  }

  return app;
};
