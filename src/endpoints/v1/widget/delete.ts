import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { Elysia, t } from "elysia";

export const v1WidgetDelete = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/delete",
    async ({ body, cookie, request }) => {
      const { widgetId } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 위젯 정보 확인
      const { data: widget } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .limit(1)
        .maybeSingle();

      // * 위젯 예외처리
      {
        if (!widget) {
          return {
            success: false,
            message: "존재하지 않는 위젯입니다.",
          };
        }
        if (widget.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 위젯입니다.",
          };
        }
      }

      // * 위젯이 속한 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", widget.workspace_id)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
      {
        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 워크스페이스입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 워크스페이스입니다.",
          };
        }
      }

      // * 유저가 위젯이 속한 워크스페이스 소유자가 아닐 경우
      if (workspace.owner !== user.id) {
        // * 유저가 위젯이 속한 워크스페이스의 멤버인지 확인
        const { data: workspaceMember } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", workspace.id)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        // * 유저가 위젯이 속한 워크스페이스의 소유자도, 멤버도 아닐 경우
        if (!workspaceMember) {
          return {
            success: false,
            message: "위젯을 삭제할 권한이 없습니다.",
          };
        }
      }

      // TODO Open A.I Assistant 삭제 원점 재검토

      // * 위젯 삭제
      const response = await supabaseClient
        .from("llami_widget")
        .update({ is_deleted: true })
        .match({ id: widgetId });

      // * 위젯 삭제 예외처리
      if (response.error) {
        console.error(response.error);
        return {
          success: false,
          message:
            "위젯을 삭제하는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속되면 관리자에게 문의해주세요.",
        };
      }

      // TODO 이전 벡터스토어 파일들 삭제 및 벡터스토어 삭제

      writeWorkspaceLog(
        {
          code: "DELETE_WIDGET",
          message: `🗑 **${workspace.name ?? "개인계정"}** 조직에서 속한 **${
            widget.name
          }** 위젯을 삭제하였습니다.\n> **${user.phone_number}** 님이 삭제를 수행하였습니다.`,
          workspace_id: workspace.id,
          issued_user_id: user.id,
        },
        request,
      );

      return {
        success: true,
        message: "Successfully deleted widget.",
      };
    },
    {
      detail: {
        tags: ["Widget"],
        description: "Delete Widget",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        widgetId: t.String({
          description: "Widget ID",
          error: "Widget ID is required",
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
