import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1AccountLoginCheck = async (app: Elysia<"/v1/account">) => {
  app.post(
    "/login/check",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });

      return {
        success: true,
        data: user,
      };
    },
    {
      detail: {
        tags: ["Account"],
        description: "Account login endpoint",
      },
      body: t.Object({
        accessToken: t.String(),
      }),
    },
  );
};
