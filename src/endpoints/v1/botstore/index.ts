import Elysia from "elysia";
import { v1BotstoreList } from "./list";
import { v1BotstoreApprovalRequest } from "./approval-request";
import { v1BotstoreCheckApproval } from "./check-approval";

export const v1Botstore = async (app: Elysia<"/v1">) => {
  app.group("/botstore", (app) => {
    v1BotstoreList(app);
    v1BotstoreApprovalRequest(app);
    v1BotstoreCheckApproval(app);
    return app;
  });
};
