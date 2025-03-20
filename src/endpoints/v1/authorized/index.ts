import Elysia from "elysia";
import { v1SendMessage } from "./send-message";
import { v1AuthorizedMessage } from "./authorized-message";

export const v1Authorized = async (app: Elysia<"/v1">) => {
  app.group("/authorized", (app) => {
    v1AuthorizedMessage(app);
    v1SendMessage(app);
    return app;
  });
};
