import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PaymentWorkspaceAssign = async (
  app: Elysia<"/v1/widget/payment">,
) => {
  app.post(
    "/assign",
    async (request) => {
      const { workspaceId } = request.body;
      const user = await getUser(request);

      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      try {
        // 워크스페이스 존재 확인
        const { data: workspace } = await supabaseClient
          .from("llami_workspace")
          .select("*, owner")
          .eq("id", workspaceId)
          .limit(1)
          .maybeSingle();

        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 워크스페이스입니다.",
          };
        }

        // 워크스페이스 소유자 확인
        if (workspace.owner !== user.id) {
          return {
            success: false,
            message:
              "워크스페이스 소유자만 Payment Workspace로 지정할 수 있습니다.",
          };
        }

        // 사용자의 기존 Payment Workspace 업데이트 또는 생성
        const { data: result, error } = await supabaseClient
          .from("llami_payment_workspace")
          .upsert(
            {
              user: user.id,
              workspace_id: workspaceId,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "user",
              ignoreDuplicates: false,
            },
          )
          .select()
          .single();

        if (error) throw error;

        // Workspace 사용량 설정 확인/생성
        await supabaseClient.from("llami_workspace_usage_limit").upsert(
          {
            workspace_id: workspaceId,
            refresh_usage_count: 0,
            special_usage_count: 0,
            usage_alert_count: 0,
            has_usage_alert_sent: false,
            refreshed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "workspace_id",
            ignoreDuplicates: true,
          },
        );

        return {
          success: true,
          message: "Payment Workspace가 성공적으로 지정되었습니다.",
          data: result,
        };
      } catch (error) {
        console.error("Payment Workspace 지정 중 오류 발생:", error);
        return {
          success: false,
          message: "Payment Workspace 지정 중 오류가 발생했습니다.",
        };
      }
    },
    {
      body: t.Object({
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
        }),
        accessToken: t.String({
          description: "Access Token",
          error: "Access Token is required",
        }),
      }),
      detail: {
        tags: ["Payment Workspace"],
        description: "워크스페이스를 Payment Workspace로 지정합니다.",
      },
    },
  );
};
