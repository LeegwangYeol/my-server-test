import Elysia from "elysia";
import { v1GetNoticeList } from "./notice-list";

export const v1Notice = async (app: Elysia<"/v1">) => {
  app.group("/notice", (app) => {
    v1GetNoticeList(app);
    return app;
  });
};
