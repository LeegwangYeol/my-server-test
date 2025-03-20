import { checkPrimaryApiKey } from "@/lib/api-key";
import { sendSms } from "@/lib/sms/solapi";
import { Elysia, t } from "elysia";

export const v1OfficeSendSMS = async (app: Elysia<"/v1/office">) => {
  app.post(
    "/send-sms",
    async ({ body: { apiKey, phoneNumber, text } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      await sendSms({
        phoneNumber,
        text,
      });

      return {
        success: true,
        message: "Successfully sent SMS",
      };
    },
    {
      detail: {
        tags: ["Office"],
        description: "Send SMS",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        phoneNumber: t.String({
          description: "Phone number",
          error: "Phone number is required",
          minLength: 1,
          maxLength: 40,
        }),
        text: t.String({
          description: "SMS text",
          error: "SMS text is required",
          minLength: 1,
          maxLength: 3000,
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
      }),
    },
  );
};
