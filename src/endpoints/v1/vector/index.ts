import Elysia from "elysia";
import { v1VectorFileQuery } from "./query";

export const v1Vector = async (app: Elysia<"/v1">) => {
  app.group("/vector", (app) => {
    v1VectorFileQuery(app);
    return app;
  });
};
