import { checkPrimaryApiKey } from "@/lib/api-key";
import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";

export const v1WorkspaceLimitPrecheck = async (
  app: Elysia<"/v1/workspace">,
) => {
  app.post(
    "/limit/precheck",
    async ({ body: { apiKey, workspaceId } }) => {
      if (!(await checkPrimaryApiKey(apiKey))) {
        throw new Error("Invalid API key");
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
      {
        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 조직입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 조직입니다.",
          };
        }
      }

      // * 워크스페이스 제한 조회
      const { data: workspaceLimit } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 제한 예외처리
      if (!workspaceLimit) {
        console.error("No Workspace limit found", workspaceId);
        return {
          success: false,
          message: "해당 조직에 제한량이 확인되지 않습니다.",
        };
      }

      // * 워크스페이스 제한 확인
      const remainLimit =
        (workspaceLimit.refresh_usage_count ?? 0) +
        (workspaceLimit.special_usage_count ?? 0);

      return {
        success: true,
        message: "조직의 제한량 정보를 확인하였습니다.",
        remain_limit: remainLimit,
      };
    },
    {
      detail: {
        tags: ["Workspace Limit"],
        description: "Check the workspace limit",
      },
      body: t.Object({
        apiKey: t.String({
          description: "LLAMI SaaS API key",
          error: "API key is required",
          minLength: 1,
          maxLength: 100,
        }),
        workspaceId: t.String({
          description: "Workspace ID",
          error: "Workspace ID is required",
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
        remain_limit: t.Optional(
          t.Integer({
            description: "Remain limit",
            error: "Remain limit is required",
          }),
        ),
      }),
    },
  );
};
