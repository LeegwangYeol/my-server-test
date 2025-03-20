import Elysia from "elysia";
import { v1OneoffPayment } from "./payment";

export const v1Oneoff = async (app: Elysia<"/v1">) => {
  app.group("/oneoff", (app) => {
    v1OneoffPayment(app);
    return app;
  });
};
