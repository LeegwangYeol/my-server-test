import Elysia from "elysia";
import { v1LinkAIQR } from "./aiqr";
import { v1ChatScript } from "./chat-script";
import { v1DeleteQR } from "./delete";

export const v1Link = async (app: Elysia<"/v1">) => {
  app.group("/link", (app) => {
    v1LinkAIQR(app);
    v1ChatScript(app);
    v1DeleteQR(app);
    return app;
  });
};
