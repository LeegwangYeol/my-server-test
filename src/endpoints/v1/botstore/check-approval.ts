import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";

export const v1BotstoreCheckApproval = (app: Elysia<"/v1/botstore">) => {
  app.post(
    "/approval/check",
    async ({ body }) => {
      const { widgetId } = body;

      let message = "승인이 거절되었습니다.";

      // 1. Check widget approval status
      const { data: approval, error: approvalError } = await supabaseClient
        .from("llami_widget_botstore_approval")
        .select("status")
        .eq("widget_id", widgetId)
        .maybeSingle();

      if (approvalError) {
        return {
          success: false,
          message: "승인 상태 조회 중 오류가 발생했습니다.",
        };
      }

      if (!approval) {
        return {
          success: true,
          message: "승인 요청 내역이 없습니다.",
        };
      }

      if (approval.status === "approved") message = "승인된 위젯입니다.";
      if (approval.status === "pending") message = "승인 대기 중입니다.";

      return {
        success: true,
        message,
      };
    },
    {
      body: t.Object({
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
          error: "Success is required",
        }),
        message: t.String({
          description: "Response message",
          error: "Message is required",
        }),
        status: t.Optional(
          t.String({
            description: "Approval status (approved, pending, rejected)",
          }),
        ),
      }),
    },
  );
  return app;
};
