import { Elysia } from "elysia";
import { v1Youtube } from "./youtube";

// 타입 단언을 사용하여 타입 오류 해결
export const v1Endpoints = async (app: any) => {
  app.group("/v1", (app: any) => {
    // 타입 단언 추가
    v1Youtube(app as any);
    return app;
  });
};
