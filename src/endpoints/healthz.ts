import Elysia, { t } from "elysia";

export const healthzEndpoint = async (app: Elysia<"">) => {
  app.group("/v1", (app) => {
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
