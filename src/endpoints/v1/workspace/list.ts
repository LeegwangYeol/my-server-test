import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1WorkspaceList = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/list",
    async ({ body, cookie }) => {
      const user = await getUser({ body, cookie });

      // * 로그인 한 이용자만 사용가능합니다.
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 사용자가 소유한 워크스페이스 조회
      const { data: ownedWorkspaces, error: ownedError } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("owner", user.id)
        .eq("is_deleted", false);

      if (ownedError) {
        console.error(ownedError);
        return {
          success: false,
          message: "워크스페이스 조회 중 오류가 발생했습니다.",
        };
      }

      // 사용자가 멤버인 워크스페이스 조회
      const { data: memberWorkspaces, error: memberError } =
        await supabaseClient
          .from("llami_workspace_member")
          .select("workspace_id")
          .eq("user_id", user.id)
          .eq("is_deleted", false);

      if (memberError) {
        console.error(memberError);
        return {
          success: false,
          message: "워크스페이스 멤버 정보 조회 중 오류가 발생했습니다.",
        };
      }

      // 사용자가 거절한 초대 조회
      const { data: rejectedInvites, error: rejectedError } =
        await supabaseClient
          .from("llami_workspace_member_invite")
          .select("workspace_id")
          .eq("invited_user_id", user.id)
          .eq("is_rejected", true)
          .eq("is_pending", false);

      if (rejectedError) {
        console.error(rejectedError);
        return {
          success: false,
          message: "거절한 초대 정보 조회 중 오류가 발생했습니다.",
        };
      }

      // 거절한 워크스페이스 ID 목록 생성
      const rejectedWorkspaceIds = new Set(
        rejectedInvites.map((invite) => invite.workspace_id),
      );
      // 멤버로 있는 워크스페이스 중 거절하지 않은 워크스페이스 ID 필터링
      const filteredMemberWorkspaceIds = memberWorkspaces
        .map((member) => member.workspace_id)
        .filter((id) => !rejectedWorkspaceIds.has(id));

      // 멤버로 있는 워크스페이스의 상세 정보 조회 (거절한 초대 제외)
      const { data: memberWorkspaceDetails, error: detailsError } =
        await supabaseClient
          .from("llami_workspace")
          .select("*")
          .in("id", filteredMemberWorkspaceIds)
          .eq("is_deleted", false);

      if (detailsError) {
        console.error(detailsError);
        return {
          success: false,
          message: "워크스페이스 상세 정보 조회 중 오류가 발생했습니다.",
        };
      }

      // 결과 병합
      const allWorkspaces = [
        ...ownedWorkspaces.map((workspace) => ({
          ...workspace,
          role: "owner",
        })),
        ...memberWorkspaceDetails.map((workspace) => ({
          ...workspace,
          role: "member",
        })),
      ];

      // 워크스페이스 ID 목록 생성
      const workspaceIds = allWorkspaces.map((workspace) => workspace.id);

      // 각 워크스페이스의 멤버 수 조회
      // TODO: drizzle 연동해서 group 연산으로 최적화
      const { data: members, error: memberCountsError } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("is_deleted", false)
        .in("workspace_id", workspaceIds);

      if (memberCountsError) {
        console.error(memberCountsError);
        return {
          success: false,
          message: "멤버 수 조회 중 오류가 발생했습니다.",
        };
      }

      // 멤버 수 맵 생성
      const memberCountMap: Record<string, number> = {};
      members.forEach((member) => {
        if (memberCountMap[member.workspace_id] == null) {
          memberCountMap[member.workspace_id] = 0;
        }
        memberCountMap[member.workspace_id]++;
      });

      // 각 워크스페이스에 멤버 수 추가
      const allWorkspacesWithMemberCount = allWorkspaces.map((workspace) => ({
        ...workspace,
        member_count: memberCountMap[workspace.id] || 0,
      }));

      return {
        success: true,
        list: allWorkspacesWithMemberCount,
      };
    },
    {
      detail: {
        tags: ["Workspace"],
        description:
          "Retrieve a list of workspaces that the access token belongs to.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
          }),
        ),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "Success",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            examples: [null],
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        list: t.Optional(
          t.Array(
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
              role: t.String({
                description: "Role in the workspace",
              }),
              member_count: t.Number({
                description: "Member count of the workspace",
              }),
            }),
          ),
        ),
      }),
    },
  );
};
