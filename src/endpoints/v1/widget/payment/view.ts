import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PaymentWorkspaceView = async (
  app: Elysia<"/v1/widget/payment">,
) => {
  app.post(
    "/view",
    async (request) => {
      const user = await getUser(request);

      if (!user) {
        return {
          success: false,
          message: "로그인한 이용자만 사용가능합니다.",
        };
      }

      try {
        const { data: result, error: paymentWorkspaceError } =
          await supabaseClient
            .from("llami_payment_workspace")
            .select("*")
            .eq("user", user.id)
            .maybeSingle();

        if (paymentWorkspaceError) {
          console.error(
            "Payment Workspace 조회 중 오류 발생:",
            paymentWorkspaceError,
          );

          return {
            success: false,
            message: "Payment Workspace 조회 중 오류가 발생했습니다.",
          };
        }

        let workspaceId: string | null = null;

        if (result) {
          workspaceId = result.workspace_id!;
        } else {
          const {
            data: workspace,
            error: workspaceError,
            count,
          } = await supabaseClient
            .from("llami_workspace")
            .select("*", { count: "exact" })
            .eq("owner", user.id);

          if (workspaceError) {
            console.error(
              "워크스페이스 정보 조회 중 오류 발생:",
              workspaceError,
            );

            return {
              success: false,
              message: "워크스페이스 정보 조회 중 오류가 발생했습니다.",
            };
          }

          if (count !== 1) {
            return {
              success: false,
              message: "워크스페이스 정보를 찾을 수 없습니다.",
            };
          }

          workspaceId = workspace[0].id;
        }

        if (!workspaceId) {
          return {
            success: false,
            message: "워크스페이스 정보를 찾을 수 없습니다.",
          };
        }

        const { data: rawWorkspace, error: workspaceError } =
          await supabaseClient
            .from("llami_workspace_usage_limit")
            .select(
              `
            refresh_usage_count,
            special_usage_count,
            workspace:llami_workspace!inner(*)
            `,
            )
            .eq("workspace_id", workspaceId)
            .maybeSingle();

        if (workspaceError) {
          console.error(
            "Payment Workspace 정보 조회 중 오류 발생:",
            workspaceError,
          );
          return {
            success: false,
            message: "Payment Workspace 정보 조회 중 오류가 발생했습니다.",
          };
        }

        if (!rawWorkspace) {
          return {
            success: false,
            message: "Payment Workspace 정보를 찾을 수 없습니다.",
          };
        }

        const data = {
          usage_limit:
            (rawWorkspace.refresh_usage_count || 0) +
            (rawWorkspace.special_usage_count || 0),
          ...rawWorkspace.workspace,
          setted_at: result?.updated_at || new Date().toISOString(),
        };

        return {
          success: true,
          message: "Payment Workspace 정보를 성공적으로 조회했습니다.",
          data,
        };
      } catch (error) {
        console.error("Payment Workspace 조회 중 오류 발생:", error);
        return {
          success: false,
          message: "Payment Workspace 조회 중 오류가 발생했습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Payment Workspace"],
        description: "사용자의 Payment Workspace 정보를 조회합니다.",
      },
      body: t.Object({
        accessToken: t.String({
          description: "Access token",
          error: "Access token is required",
        }),
      }),
    },
  );
};
