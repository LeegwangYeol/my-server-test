import Elysia from "elysia";
import { v1AccountOtpCheck } from "./otp-check";
import { v1AccountOtpSms } from "./otp-sms";
import { v1AccountLogout } from "./logout";
import { v1AccountLoginCheck } from "./login-check";
import { v1UpdateUserProfile } from "./update-user-profile";
import { v1AccountGetUserProfile } from "./get-user-profile";

export const v1Account = async (app: Elysia<"/v1">) => {
  app.group("/account", (app) => {
    v1AccountOtpSms(app);
    v1AccountOtpCheck(app);
    v1AccountLogout(app);
    v1AccountLoginCheck(app);
    v1UpdateUserProfile(app);
    v1AccountGetUserProfile(app);
    return app;
  });
};
