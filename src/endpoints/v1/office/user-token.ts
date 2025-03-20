import { checkPrimaryApiKey } from "@/lib/api-key";
import { createJwt } from "@/lib/jwt";
import { supabaseClient } from "@/lib/supabase/client";
import { parsePhoneNumber } from "@/src/utils/parse-phone-number";
import { Elysia, t } from "elysia";

export const v1OfficeUserToken = async (app: Elysia<"/v1/office">) => {
  app.post(
    "/user-token",
    async ({ body: { apiKey, phoneNumber: _phoneNumber } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      const phoneNumber = parsePhoneNumber(_phoneNumber);
      const { data: user } = await supabaseClient
        .from("user")
        .select("*")
        .eq("phone_number", phoneNumber)
        .limit(1)
        .maybeSingle();

      if (!user) {
        return {
          success: false,
          message: "User not found",
        };
      }

      const token = createJwt({ userId: user.id });
      return {
        success: true,
        message: "User token created",
        token,
      };
    },
    {
      detail: {
        tags: ["Office"],
        description: "Get User Token",
      },
      body: t.Object({
        apiKey: t.String({
          description: "API Key",
          error: "API Key is required",
          minLength: 1,
          maxLength: 100,
        }),
        phoneNumber: t.String({
          description: "Phone Number",
          error: "Phone Number is required",
          minLength: 1,
          maxLength: 100,
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            error: "Message is required",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        token: t.Optional(
          t.String({
            description: "User Token",
            error: "User Token is required",
          }),
        ),
      }),
    },
  );
};
