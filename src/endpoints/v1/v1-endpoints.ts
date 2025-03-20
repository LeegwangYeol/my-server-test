import Elysia from "elysia";
import { v1Youtube } from "./youtube";

export const v1Endpoints = async (app: any) => {
  app.group("/v1", (app: any) => {
    v1Youtube(app);
    return app;
  });
};
