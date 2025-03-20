import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceLimitView = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/limit/view",
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

      // * 워크스페이스에 속한 사용자 예외처리
      if (workspace.owner !== user.id) {
        // * 워크스페이스에 속한 사용자인지 확인
        const { data: workspaceMember } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (!workspaceMember) {
          return {
            success: false,
            message: "해당 조직에 속한 사용자가 아닙니다.",
          };
        }
      }

      // * 위젯 제한 조회
      const { data: limit, error } = await supabaseClient
        .from("llami_workspace_usage_limit")
        .select("*")
        .eq("workspace_id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 조직 제한 예외처리
      if (error) {
        return {
          success: false,
          message: "조직 제한량 조회 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        message: "조직 제한량 조회 성공",
        limit,
      };
    },
    {
      detail: {
        tags: ["Workspace Limit"],
        description: "View Workspace Limit",
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
        limit: t.Optional(t.Any({})),
      }),
    },
  );
};
