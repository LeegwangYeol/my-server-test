import Elysia from "elysia";
import { v1PostBillingCard } from "./post";
import { v1PostBillingCardList } from "./list";
import { v1DeleteBillingCard } from "./delete";
import { v1PatchBillingCard } from "./patch";

export const v1BillingCard = async (app: Elysia<"/v1/billing">) => {
  app.group("/card", (app) => {
    v1PostBillingCard(app);
    v1PostBillingCardList(app);
    v1DeleteBillingCard(app);
    v1PatchBillingCard(app);
    return app;
  });
};
