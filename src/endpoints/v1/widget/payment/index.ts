import Elysia from "elysia";
import { v1PaymentWorkspaceAssign } from "./assign";
import { v1PaymentWorkspaceView } from "./view";
import { v1PaymentWorkspaceDelete } from "./delete";

export const v1PaymentWorkspace = async (app: Elysia<"/v1/widget">) => {
  app.group("/payment", (app) => {
    v1PaymentWorkspaceAssign(app);
    v1PaymentWorkspaceView(app);
    v1PaymentWorkspaceDelete(app);
    return app;
  });
};
