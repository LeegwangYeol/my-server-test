import Elysia from "elysia";
import { v1RealtimeEndpoint } from "./ws";

export const v1Realtime = async (app: Elysia<"/v1">) => {
  app.group("/realtime", (app) => {
    /**
     * 웹소켓의 경우 app.group으로 엔드포인트 사용시 오류가 발생하여 별도로 처리
     */
    //v1RealtimeEndpoint(app);
    return app;
  });
};
