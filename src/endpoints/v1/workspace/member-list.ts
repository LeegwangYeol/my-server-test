import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceMemberList = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/member/list",
    async ({ body, cookie }) => {
      const { workspaceId } = body;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 해당 조직 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 조직 예외처리
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
            message: "삭제된 조직입니다.",
          };
        }
      }

      // * 조직 멤버 리스트 조회
      const response = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("is_deleted", false);

      // * 조직 맴버 리스트 예외처리
      {
        if (response.error) {
          console.error(response.error);
          return {
            success: false,
            message:
              "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
          };
        }
        if (
          !response.data?.find((member) => member.user_id === user.id) &&
          workspace.owner !== user.id
        ) {
          return {
            success: false,
            message:
              "조직의 소유자 또는 멤버만 해당 조직에 속한 멤버 리스트를 조회할 수 있습니다.",
          };
        }
      }

      // * 조직 임시 멤버 리스트 조회
      const preMemberInvites = await supabaseClient
        .from("llami_workspace_member_invite")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("is_pending", true)
        .eq("is_rejected", false);

      // * 조직 임시 맴버 리스트를 토대로 users 테이블에서 유저 정보 조회
      const preMembers = (
        await Promise.all(
          preMemberInvites.data!.map(async (invite) => {
            const { data: user } = await supabaseClient
              .from("user")
              .select("*")
              .eq("id", invite.invited_user_id!)
              .eq("is_deleted", false)
              .limit(1)
              .maybeSingle();

            if (!user) {
              throw new Error("존재하지 않는 유저입니다.");
            }
            return {
              ...user,
              ...invite,
              id: user.id,
              is_deleted: invite.is_deleted,
              user_id: user.id,
            };
          }),
        )
      ).filter((user) => user !== null);

      return {
        success: true,
        message: "조직 멤버 목록 조회에 성공했습니다.",
        members: response.data,
        pre_members: preMembers,
      };
    },
    {
      detail: {
        tags: ["Workspace Member"],
        description: "Retrieve a list of members in the workspace.",
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
        }),
        message: t.Optional(
          t.String({
            description: "Message",
          }),
        ),
        members: t.Optional(
          t.Array(
            t.Object({
              created_at: t.String({
                description: "Created At",
              }),
              id: t.String({
                description: "ID",
              }),
              updated_at: t.Nullable(
                t.String({
                  description: "Updated At",
                }),
              ),
              user_id: t.String({
                description: "User ID",
              }),
              workspace_id: t.String({
                description: "Workspace ID",
              }),
            }),
          ),
        ),
        pre_members: t.Optional(t.Array(t.Any())),
      }),
    },
  );
};
