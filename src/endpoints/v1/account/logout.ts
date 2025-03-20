import { Elysia, t } from "elysia";

export const v1AccountLogout = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/logout",
    async ({ cookie: { accessToken }, request }) => {
      const clientDomain = new URL(
        request.headers.get("origin") ?? "https://llami.net",
      ).hostname;

      accessToken.set({
        domain: clientDomain,
        secure: true,
        httpOnly: false,
        expires: new Date(0),
        path: "/",
      });
      return {
        success: true,
      };
    },
    {
      detail: {
        tags: ["Account"],
        description:
          "Logout the user by clearing the access token from the cookie.",
      },
    },
  );
};
