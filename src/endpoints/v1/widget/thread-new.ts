import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetThreadNew = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/new",
    async ({ body, cookie }) => {
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
        .eq("id", body.widgetId)
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

      // * 유저가 속한 워크스페이스 예외처리
      if (workspace.owner !== user.id) {
        // * 유저가 속한 워크스페이스 정보 확인
        const { data: userWorkspace } = await supabaseClient
          .from("llami_workspace_member")
          .select("*")
          .eq("workspace_id", widget.workspace_id)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (!userWorkspace) {
          return {
            success: false,
            message: "스레드가 속한 그룹에 속한 사용자가 아닙니다.",
          };
        }
      }

      /**
       * @todo: open ai thread id를 body에서 받지 않고 직접 여기서 생성.
       */
      const openai_thread_id = body.openAIThreadId ?? "";

      // * 스레드 생성
      const { data: thread, error } = await supabaseClient
        .from("llami_widget_thread")
        .insert({
          workspace_id: workspace.id,
          openai_thread_id,
          last_message: null,
          widget_id: widget.id,
          message_count: 0,
        })
        .select("*")
        .limit(1)
        .maybeSingle();

      // * 스레드 생성 예외처리
      if (error) {
        console.error(error);
        return {
          success: false,
          message: "스레드 생성에 실패했습니다.",
        };
      }

      return {
        success: true,
        message: "스레드가 생성되었습니다.",
        thread,
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Create a new thread",
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
        }),
        openAIThreadId: t.Optional(
          t.String({
            description: "Open ai Thread Id",
          }),
        ),
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
        thread: t.Optional(
          t.Any({
            description: "Thread",
          }),
        ),
      }),
    },
  );
};
