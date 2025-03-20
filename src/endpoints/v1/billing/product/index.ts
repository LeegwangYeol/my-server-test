import Elysia from "elysia";
import { v1PostBillingProductList } from "./list";

export const v1BillingProduct = async (app: Elysia<"/v1/billing">) => {
  app.group("/product", (app) => {
    v1PostBillingProductList(app);
    return app;
  });
};
