import Elysia from "elysia";
import { v1PaymentDepositView } from "./deposit-view";
import { v1PaymentTossCallback } from "./toss-callback";
import { v1PaymentDepositWorkspace } from "./deposit-workspace";
import { v1PaymentAddSpecialLimit } from "./add-special-limit";

export const v1Payment = async (app: Elysia<"/v1">) => {
  app.group("/payment", (app) => {
    v1PaymentTossCallback(app);
    v1PaymentDepositView(app);
    v1PaymentDepositWorkspace(app);
    v1PaymentAddSpecialLimit(app);
    return app;
  });
};
