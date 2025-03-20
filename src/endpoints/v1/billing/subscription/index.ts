import Elysia from "elysia";
import { v1PostBillingSubscription } from "./post";
import { v1PostBillingSubscriptionList } from "./list";
import { v1DeleteBillingSubscription } from "./delete";

export const v1BillingSubscription = async (app: Elysia<"/v1/billing">) => {
  app.group("/subscription", (app) => {
    v1PostBillingSubscription(app);
    v1PostBillingSubscriptionList(app);
    v1DeleteBillingSubscription(app);
    return app;
  });
};
