import Elysia from "elysia";
import { v1LlamiwikiSignIn } from "./sign-in";

export const v1Dashboard = async (app: Elysia<"/v1">) => {
  app.group("/llamiwiki", (app) => {
    v1LlamiwikiSignIn(app);
    return app;
  });
};
