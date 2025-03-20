import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceView = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/view",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 워크스페이스 정보 확인
      const response = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", body.workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
      if (response.error || !response.data) {
        return {
          success: false,
          message: response.error
            ? response.error.message
            : "워크스페이스를 찾을 수 없습니다.",
        };
      }

      if (response.data.is_deleted) {
        return {
          success: false,
          message: "삭제된 워크스페이스입니다.",
        };
      }

      // * 사용자가 워크스페이스 소유자인지 확인
      if (response.data.owner !== user.id) {
        // * 사용자가 워크스페이스 멤버인지 확인
        const { data: member } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", body.workspaceId)
          .eq("user_id", user.id)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (!member) {
          return {
            success: false,
            message: "해당 워크스페이스의 정보를 열람할 권한이 없습니다.",
          };
        }
      }

      return {
        success: true,
        message: "성공적으로 조회되었습니다.",
        workspace: response.data,
      };
    },
    {
      detail: {
        tags: ["Workspace"],
        description: "View the workspace information.",
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
          maxLength: 1000,
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
        workspace: t.Optional(
          t.Object({
            created_at: t.String({
              description: "Created At",
              minLength: 1,
              maxLength: 1000,
            }),
            description: t.Nullable(
              t.String({
                description: "Description",
                minLength: 0,
                maxLength: 1000,
              }),
            ),
            id: t.String({
              description: "ID",
              minLength: 1,
              maxLength: 1000,
            }),
            is_deleted: t.Nullable(
              t.Boolean({
                description: "Is Deleted",
              }),
            ),
            name: t.Nullable(
              t.String({
                description: "Name",
                minLength: 1,
                maxLength: 1000,
              }),
            ),
            only_owner_can_add_members: t.Nullable(
              t.Boolean({
                description: "Only Owner Can Add Members",
              }),
            ),
            only_owner_can_edit_info: t.Nullable(
              t.Boolean({
                description: "Only Owner Can Edit Info",
              }),
            ),
            owner: t.Nullable(
              t.String({
                description: "Owner",
                minLength: 1,
                maxLength: 1000,
              }),
            ),
            updated_at: t.Nullable(
              t.String({
                description: "Updated At",
                minLength: 1,
                maxLength: 1000,
              }),
            ),
          }),
        ),
      }),
    },
  );
};
