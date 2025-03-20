import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetTransfer = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/transfer",
    async ({ body, cookie, request }) => {
      const { widgetId, workspaceId } = body;

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

      // * 위젯이 속한 워크스페이스 예외처리
      {
        if (!workspace) {
          return {
            success: false,
            message: "존재하지 않는 그룹의 위젯입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 그룹의 위젯입니다.",
          };
        }
      }

      // * 위젯이 속한 워크스페이스의 소유자인지 확인
      if (workspace.owner !== user.id) {
        return {
          success: false,
          message:
            "위젯을 옮길 권한이 없습니다. 위젯 소유권 이전은 위젯이 현재 속한 그룹의 소유자만 시도 가능합니다.",
        };
      }

      // * 요청받은 워크스페이스 정보 확인
      const { data: newWorkspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 요청받은 워크스페이스 예외처리
      {
        if (!newWorkspace) {
          return {
            success: false,
            message: "존재하지 않는 워크스페이스입니다.",
          };
        }
        if (newWorkspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 워크스페이스입니다.",
          };
        }
      }

      // * 유저가 위젯이 속한 워크스페이스 소유자가 아닐 경우
      if (newWorkspace.owner !== user.id) {
        // * 유저가 위젯이 속한 워크스페이스의 멤버인지 확인
        const { data: member } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        // * 멤버 예외처리
        if (!member) {
          return {
            success: false,
            message:
              "권한이 없습니다. 위젯 자체에 대한 소유권은 확인되지만, 소유권이 옮겨질 그룹의 권한이 확인되지 않습니다. 소유권이 옮겨질 그룹의 소유자나 멤버만 위젯을 이동할 수 있습니다.",
          };
        }
      }

      // * 위젯 소유권 이전
      const response = await supabaseClient
        .from("llami_widget")
        .update({
          workspace_id: workspaceId,
        })
        .eq("id", widgetId);

      // * 위젯 소유권 이전 예외처리
      if (response.error) {
        console.error(response.error);
        return {
          success: false,
          message:
            "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      // * 위젯에 속한 스레드들의 소유권 이전
      const threads = await supabaseClient
        .from("llami_widget_thread")
        .select("*")
        .eq("widget_id", widgetId);

      if (threads.error) {
        console.error(threads.error);
        return {
          success: false,
          message:
            "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      for (const thread of threads.data) {
        await supabaseClient
          .from("llami_widget_thread")
          .update({
            workspace_id: workspaceId,
          })
          .eq("id", thread.id);
      }

      writeWorkspaceLog(
        {
          code: "WIDGET_TRANSFER",
          issued_user_id: user.id,
          workspace_id: workspaceId,
          message: `🔐 **${workspace.name ?? "개인계정"}** 그룹의 **${widget.name}** 위젯을 **${
            newWorkspace.name ?? "새 개인계정"
          }** 그룹으로 이동하였습니다.\n> **${user.phone_number}**님이 위젯 소유권 이동을 수행하였습니다.`,
        },
        request,
      );

      return {
        success: true,
        message: "성공적으로 위젯 소유권을 이동하였습니다.",
      };
    },
    {
      detail: {
        tags: ["Widget"],
        description: "Transfers widget ownership to another workspace.",
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
