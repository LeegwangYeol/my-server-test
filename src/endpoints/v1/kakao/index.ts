import Elysia from "elysia";
import { v1ChatbotConnect } from "./chatbot-connect";
import { v1KakaoWidgetConnect } from "./kakao-widget-connect";

export const v1Kakao = async (app: Elysia<"/v1">) => {
  app.group("/kakao", (app) => {
    v1ChatbotConnect(app);
    v1KakaoWidgetConnect(app);
    return app;
  });
};
