import { Elysia } from "elysia";
import { v1CreateApiKey } from "./create";
import { v1ListApiKey } from "./list";
import { v1DeleteApiKey } from "./delete";
import { v1UpdateApiKey } from "./update";

export const v1ApiKey = async (app: Elysia<"/v1">) => {
  app.group("/api-key", (app) => {
    v1CreateApiKey(app);
    v1ListApiKey(app);
    v1DeleteApiKey(app);
    v1UpdateApiKey(app);

    return app;
  });
};
