import { supabaseClient } from "@/lib/supabase/client";
import { Elysia, t } from "elysia";

export const v1BotstoreList = async (app: Elysia<"/v1/botstore">) => {
  app.post(
    "/list",
    async () => {
      // * 위젯 목록 조회
      const { data: widgets, error } = await supabaseClient
        .from("llami_widget")
        .select(
          `
          *,
          llami_widget_botstore_approval!inner (
            status
          )
        `,
        )
        .eq("payment_type", "USER_PAY")
        .eq("is_deleted", false)
        .eq("llami_widget_botstore_approval.status", "approved");

      // * 위젯 목록 예외처리
      if (error) {
        console.error(error);
        return {
          success: false,
          message:
            "위젯 목록을 불러오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속되면 관리자에게 문의해주세요.",
        };
      }

      // * 위젯 목록 반환
      return {
        success: true,
        message: "Successfully retrieved widgets.",
        widgets:
          widgets?.map((widget) => ({
            ...widget,
            questions: widget.questions as string[] | null,
          })) ?? [],
      };
    },
    {
      detail: {
        tags: ["Botstore"],
        description: "Retrieve a list of widgets that marked as User Payment.",
      },
      response: t.Object({
        success: t.Boolean({
          description: "Success",
        }),
        message: t.Optional(
          t.String({
            description: "Message",
            minLength: 1,
            maxLength: 1000,
          }),
        ),
        widgets: t.Optional(
          t.Array(
            t.Object({
              id: t.String({
                description: "Widget ID",
              }),
              created_at: t.String({
                description: "Created At",
              }),
              updated_at: t.Nullable(
                t.String({
                  description: "Updated At",
                }),
              ),
              name: t.Nullable(
                t.String({
                  description: "Name",
                }),
              ),
              description: t.Nullable(
                t.String({
                  description: "Description",
                }),
              ),
              category: t.Nullable(
                t.String({
                  description: "Widget Category",
                }),
              ),
              avatar_src: t.Nullable(
                t.String({
                  description: "Avatar Src",
                }),
              ),
              theme: t.Nullable(
                t.String({
                  description: "Widget Theme",
                }),
              ),
              animation_theme: t.Nullable(
                t.String({
                  description: "Widget Animation Theme",
                }),
              ),
              prompt: t.Nullable(
                t.String({
                  description: "Prompt",
                }),
              ),
              alter_prompt: t.Nullable(
                t.String({
                  description: "Alter Prompt",
                }),
              ),
              widget_message_title: t.Nullable(
                t.String({
                  description: "Widget Message Title",
                }),
              ),
              widget_message_content: t.Nullable(
                t.String({
                  description: "Widget Message Content",
                }),
              ),
              widget_margin_right: t.Nullable(
                t.Number({
                  description: "Widget Margin Right",
                }),
              ),
              widget_margin_bottom: t.Nullable(
                t.Number({
                  description: "Widget Margin Bottom",
                }),
              ),
              questions: t.Nullable(
                t.Array(
                  t.String({
                    description: "Default Questions",
                  }),
                ),
              ),
              workspace_id: t.String({
                description: "Workspace ID",
              }),
              widget_auto_open: t.Nullable(
                t.Boolean({
                  description: "Widget Auto Open",
                }),
              ),
              welcome_message: t.Nullable(
                t.String({
                  description: "Welcome Message",
                }),
              ),
              is_deleted: t.Nullable(
                t.Boolean({
                  description: "Is Deleted",
                }),
              ),
              openai_assistant_id: t.Nullable(
                t.String({
                  description: "OpenAI Assistant ID",
                }),
              ),
              font_family: t.Nullable(
                t.String({
                  description: "Font Family",
                }),
              ),
              icon: t.Nullable(
                t.String({
                  description: "chatbot custom image icon",
                }),
              ),
              logo: t.Nullable(
                t.String({
                  description: "chatbot custom image logo",
                }),
              ),
              store_type: t.Optional(
                t.Nullable(
                  t.String({
                    description: "Store Type",
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    },
  );
};
