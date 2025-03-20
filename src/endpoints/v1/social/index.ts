import Elysia from "elysia";
import { v1SocialInstagramWebhook } from "./instagram/webhook";
import { v1SocialInstagramOAuth } from "./instagram/oauth";
import { v1SocialInstagramApplyWidget } from "./instagram/apply-widget";

export const v1Social = async (app: Elysia<"/v1">) => {
  app.group("/social", (app) => {
    v1SocialInstagramWebhook(app);
    v1SocialInstagramOAuth(app);
    v1SocialInstagramApplyWidget(app);
    return app;
  });
};
