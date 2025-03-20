import Elysia from "elysia";
import { v1ScrapGoogleSearch } from "./google-search";
import { v1ScrapNaverSearch } from "./naver-search";
import { v1ScrapCoupangSearch } from "./coupang-search";

export const v1Scrap = async (app: Elysia<"/v1">) => {
  app.group("/scrap", (app) => {
    v1ScrapGoogleSearch(app);
    v1ScrapNaverSearch(app);
    v1ScrapCoupangSearch(app);
    return app;
  });
};
