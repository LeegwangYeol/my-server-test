import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetThreadDelete = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/delete",
    async ({ body, cookie }) => {
      const { threadId } = body;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 스레드 정보 확인
      const { data: thread } = await supabaseClient
        .from("llami_widget_thread")
        .select("*")
        .eq("id", threadId)
        .limit(1)
        .maybeSingle();

      // * 스레드 예외처리
      {
        if (!thread) {
          return {
            success: false,
            message: "존재하지 않는 스레드입니다.",
          };
        }
        if (thread.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 스레드입니다.",
          };
        }
      }

      // * 스레드 속한 위젯 정보 확인
      const { data: widget } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", thread.widget_id)
        .limit(1)
        .maybeSingle();

      // * 스레드 속한 위젯 예외처리
      {
        if (!widget) {
          return {
            success: false,
            message: "존재하지 않는 위젯의 스레드입니다.",
          };
        }
        if (widget.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 위젯의 스레드입니다.",
          };
        }
      }

      // * 워크스페이스 정보 확인
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
            message: "존재하지 않는 그룹의 위젯의 스레드입니다.",
          };
        }
        if (workspace.is_deleted) {
          return {
            success: false,
            message: "이미 삭제된 그룹의 위젯의 스레드입니다.",
          };
        }
      }

      // * 워크스페이스에 속한 사용자 예외처리
      if (workspace.owner !== user.id) {
        // * 워크스페이스에 속한 사용자인지 확인
        const { data: workspaceMember } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", widget.workspace_id)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (!workspaceMember) {
          return {
            success: false,
            message: "스레드가 속한 그룹에 속한 사용자가 아닙니다.",
          };
        }
      }

      // * 스레드 삭제
      const response = await supabaseClient
        .from("llami_widget_thread")
        .update({ is_deleted: true })
        .eq("id", threadId);

      // * 스레드 삭제 예외처리
      if (response.error) {
        console.error(response.error);
        return {
          success: false,
          message:
            "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
        };
      }

      return {
        success: true,
        message: "스레드가 삭제되었습니다.",
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Delete Thread",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
        threadId: t.String({
          description: "Thread ID",
          error: "Thread ID is required",
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
