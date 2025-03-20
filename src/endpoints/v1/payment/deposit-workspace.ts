import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1PaymentDepositWorkspace = async (app: Elysia<"/v1/payment">) => {
  app.post(
    "/deposit/workspace",
    async ({ body, cookie }) => {
      const { workspaceId } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 정보가 없을 경우
      if (!workspace) {
        return {
          success: false,
          message: "워크스페이스 정보가 없습니다.",
        };
      }

      // * 예치금 정보 확인
      const { data: deposit } = await supabaseClient
        .from("llami_deposit")
        .select("*")
        .eq("user", user.id)
        .limit(1)
        .maybeSingle();

      // * 예치금 정보가 없을 경우
      if (!deposit) {
        return {
          success: false,
          message: "예치금 정보가 없습니다.",
        };
      }

      // * 워크스페이스 예치금이 없을경우
      if ((deposit.workspace_month_pay ?? 0) <= 0) {
        return {
          success: false,
          message: "그룹에 사용 가능한 예치금 정보가 없습니다.",
        };
      }

      // * 예치금 사용
      await supabaseClient.from("llami_deposit").upsert({
        user: user.id,
        workspace_month_pay: (deposit.workspace_month_pay ?? 0) - 1,
      });

      // * 해당 워크스페이스 스페셜 토큰 확인
      const { data: workspaceUsageLimit } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 스페셜 토큰 추가
      const { error } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .upsert({
          workspace_id: workspaceId,
          special_usage_count:
            (workspaceUsageLimit?.special_usage_count ?? 0) + 10000,
        });

      if (error) {
        return {
          success: false,
          message:
            "네트워크 문제로 인해 예치금 사용에 실패했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      // * 성공
      return {
        success: true,
        message: "예치금 사용 성공",
      };
    },
    {
      detail: {
        tags: ["Payment"],
        description: "Deposit workspace",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
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
      }),
    },
  );
};
