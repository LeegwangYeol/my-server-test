import Elysia from "elysia";
import { v1BillingProduct } from "./product";
import { v1BillingSubscription } from "./subscription";
import { v1BillingCard } from "./card";

export const v1Billing = async (app: Elysia<"/v1">) => {
  app.group("/billing", (app) => {
    v1BillingCard(app);
    v1BillingProduct(app);
    v1BillingSubscription(app);
    return app;
  });
};
