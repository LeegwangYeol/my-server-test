import Elysia from "elysia";
import { v1PageRank } from "./page-rank";

export const v1Crawl = async (app: Elysia<"/v1">) => {
  app.group("/crawl", (app) => {
    v1PageRank(app);
    return app;
  });
};
