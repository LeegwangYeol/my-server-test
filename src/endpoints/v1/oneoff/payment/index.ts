import Elysia from "elysia";
import { v1OneoffCard } from "./card";

export const v1OneoffPayment = async (app: Elysia<"/v1/oneoff">) => {
  app.group("/payment", (app) => {
    v1OneoffCard(app);
    return app;
  });
};
