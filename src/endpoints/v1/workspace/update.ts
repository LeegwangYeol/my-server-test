import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WorkspaceUpdate = async (app: Elysia<"/v1/workspace">) => {
  app.post(
    "/update",
    async ({ body, cookie, request }) => {
      const user = await getUser({ body, cookie });
      // * 로그인 한 이용자만 사용가능합니다.
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      const { workspace } = body;

      const currentTime = new Date().toISOString();

      // * 워크스페이스 id 를 받은 경우 해당 워크스페이스 정보를 갱신합니다.
      // * 워크스페이스 id 가 없는 경우 새로운 워크스페이스를 생성합니다.
      if (workspace.id) {
        // * 워크스페이스 정보 확인
        const { data: alreadyExistWorkspaceData } = await supabaseClient
          .from("llami_workspace")
          .select("*")
          .eq("id", workspace.id)
          .limit(1)
          .maybeSingle();

        // * 워크스페이스 예외처리
        {
          if (!alreadyExistWorkspaceData) {
            return {
              success: false,
              message: "존재하지 않는 워크스페이스입니다.",
            };
          }

          if (
            workspace.only_owner_can_edit_info &&
            alreadyExistWorkspaceData.owner !== user.id
          ) {
            return {
              success: false,
              message: "소유자만 수정할 수 있습니다.",
            };
          }

          if (alreadyExistWorkspaceData.is_deleted) {
            return {
              success: false,
              message: "삭제된 워크스페이스입니다.",
            };
          }
        }

        // * 워크스페이스 갱신
        const response = await supabaseClient
          .from("llami_workspace")
          .update({
            ...workspace,
            updated_at: new Date().toISOString(),
          })
          .match({ id: workspace.id });

        // * 만약 워크스페이스 리미트가 없는 경우 생성
        const { data: widgetTokenLimit } = await supabaseClient
          .from("llami_workspace_usage_limit")
          .select("*")
          .eq("workspace_id", workspace.id)
          .limit(1)
          .maybeSingle();

        if (!widgetTokenLimit) {
          await supabaseClient.from("llami_workspace_usage_limit").insert({
            workspace_id: workspace.id,
            refresh_usage_count: 20,
            special_usage_count: 0,
            has_usage_alert_sent: false,
            usage_alert_count: 4,
            created_at: currentTime,
            refreshed_at: currentTime,
            updated_at: currentTime,
          });
        }

        // * 워크스페이스 정보 갱신 로그 전송
        writeWorkspaceLog(
          {
            code: "UPDATE",
            message: `🔖 조직 정보 갱신이 발생하였습니다.\n> **${
              user.phone_number
            }**님의 조직 정보가 갱신되었습니다 (명칭: ${workspace.name ?? "개인계정"}, 설명: ${
              workspace.description
            }, 멤버 추가 권한: ${
              workspace.only_owner_can_add_members
                ? "소유자만 가능"
                : "모두 가능"
            }, 정보 수정 권한: ${workspace.only_owner_can_edit_info ? "소유자만 가능" : "모두 가능"})`,
            workspace_id: workspace.id,
            issued_user_id: user.id,
          },
          request,
        );

        return {
          success: response.error ? false : true,
          message: response.error
            ? response.error.message
            : "성공적으로 업데이트 되었습니다.",
        };
      } else {
        // * 워크스페이스 생성
        const response = await supabaseClient
          .from("llami_workspace")
          .insert({
            ...workspace,
            owner: user.id,
            updated_at: currentTime,
          })
          .select("*")
          .limit(1)
          .maybeSingle();

        if (response.error) {
          return {
            success: false,
            message: "워크스페이스 생성에 실패했습니다.",
          };
        }

        // * 워크스페이스 리미트 생성
        await supabaseClient.from("llami_workspace_usage_limit").insert({
          workspace_id: response.data!.id,
          refresh_usage_count: 20,
          special_usage_count: 0,
          has_usage_alert_sent: false,
          usage_alert_count: 4,
          created_at: currentTime,
          refreshed_at: currentTime,
          updated_at: currentTime,
        });

        // * 워크스페이스 생성 로그 전송
        writeWorkspaceLog(
          {
            code: "CREATE",
            message: `🎉 신규 조직이 생성되었습니다.\n> **${user.phone_number}**님이 신규 조직을 생성하였습니다.`,
            workspace_id: response.data!.id,
            issued_user_id: user.id,
          },
          request,
        );

        return {
          success: true,
          message: "성공적으로 업데이트 되었습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Workspace"],
        description:
          "Updates the workspace. If no ID is provided, a new workspace is created.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
          }),
        ),
        workspace: t.Object({
          description: t.String({
            description: "Description",
            error: "Description is required",
          }),
          id: t.Optional(
            t.String({
              description: "Workspace ID",
            }),
          ),
          name: t.String({
            description: "Workspace Name",
            error: "Name is required",
            minLength: 1,
            maxLength: 1000,
          }),
          only_owner_can_add_members: t.Boolean({
            description: "Only Owner Can Add Members",
            error: "Only Owner Can Add Members is required",
          }),
          only_owner_can_edit_info: t.Boolean({
            description: "Only Owner Can Edit Info",
            error: "Only Owner Can Edit Info is required",
          }),
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
