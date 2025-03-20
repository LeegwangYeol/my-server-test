import Elysia from "elysia";
import { v1OfficeSendSMS } from "./send-sms";
import { v1OfficeUploadImage } from "./upload-image";
import { v1OfficeUserToken } from "./user-token";

export const v1Office = async (app: Elysia<"/v1">) => {
  app.group("/office", (app) => {
    v1OfficeSendSMS(app);
    v1OfficeUploadImage(app);
    v1OfficeUserToken(app);
    return app;
  });
};
