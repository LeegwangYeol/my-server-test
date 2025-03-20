import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

const workspace_with_limit = t.Object({
  id: t.String(),
  created_at: t.String(),
  name: t.String(),
  description: t.Nullable(t.String()),
  owner: t.String(),
  limit: t.Number(),
  is_deleted: t.Boolean(),
  only_owner_can_add_members: t.Boolean(),
  only_owner_can_edit_info: t.Boolean(),
  updated_at: t.String(),
  is_default: t.Boolean(),
});

export const v1ChatOverview = async (app: Elysia<"/v1/chat">) => {
  app.post(
    "/overview",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 1. 사용자가 소유한 워크스페이스 조회
      const { data: _workspaces, error } = await supabaseClient
        .from("llami_workspace")
        .select(
          "*, limit:llami_workspace_usage_limit(refresh_usage_count,special_usage_count)",
        )
        .eq("owner", user.id)
        .eq("is_deleted", false)
        .order("is_default", { ascending: false });

      if (error) {
        console.error(error);
        return {
          success: false,
          message: "워크스페이스 조회 중 오류가 발생했습니다.",
        };
      }

      const workspaces = _workspaces.map((e) => ({
        ...e,
        limit:
          (e.limit?.refresh_usage_count ?? 0) +
          (e.limit?.special_usage_count ?? 0),
      }));

      // default_workspace를 올바르게 할당
      const default_workspace =
        workspaces.length > 0 && workspaces[0].is_default === true
          ? (workspaces.shift() ?? null)
          : null;

      return {
        success: true,
        message: "워크스페이스 목록 조회에 성공했습니다.",
        data: {
          default_workspace,
          workspaces,
        },
      };
    },
    {
      body: t.Object({
        accessToken: t.String({
          description: "Access Token",
          error: "Access Token is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.String(),
        data: t.Optional(
          t.Object({
            default_workspace: t.Nullable(workspace_with_limit),
            workspaces: t.Array(workspace_with_limit),
          }),
        ),
      }),
    },
  );
};
