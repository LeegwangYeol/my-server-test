import Elysia, { t } from "elysia";

// 타입 단언을 사용하여 타입 오류 해결
export const healthzEndpoint = async (app: any) => {
  app.group("/v1", (app: any) => {
    app.get(
      "/healthz",
      async () => {
        return "OK";
      },
      {
        detail: {
          tags: ["Health"],
          description: "Health check endpoint",
        },
        response: t.String({
          description: "Health check response",
          example: "OK",
        }),
      },
    );
    return app;
  });
};
