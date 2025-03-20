import Elysia from "elysia";
import { v1ChatOverview } from "./overview";
import { v1ChatSetDefaultWorkspace } from "./set-default-workspace";

export const v1Chat = async (app: Elysia<"/v1">) => {
  app.group("/chat", (app) => {
    v1ChatOverview(app);
    v1ChatSetDefaultWorkspace(app);
    return app;
  });
};
