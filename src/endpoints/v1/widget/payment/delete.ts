import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PaymentWorkspaceDelete = async (
  app: Elysia<"/v1/widget/payment">,
) => {
  app.post(
    "/delete",
    async (request) => {
      const user = await getUser(request);

      if (!user) {
        return {
          success: false,
          message: "로그인한 이용자만 사용가능합니다.",
        };
      }

      try {
        const { error } = await supabaseClient
          .from("llami_payment_workspace")
          .delete()
          .eq("user", user.id)
          .maybeSingle();

        if (error) throw error;

        return {
          success: true,
          message: "Payment Workspace가 성공적으로 삭제되었습니다.",
        };
      } catch (error) {
        console.error("Payment Workspace 삭제 중 오류 발생:", error);
        return {
          success: false,
          message: "Payment Workspace 삭제 중 오류가 발생했습니다.",
        };
      }
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access token",
          error: "Access token is required",
        }),
      }),

      detail: {
        tags: ["Payment Workspace"],
        description: "사용자의 Payment Workspace 지정을 해제합니다.",
      },
    },
  );
};
