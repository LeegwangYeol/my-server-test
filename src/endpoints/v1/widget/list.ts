import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/list",
    async ({ body, cookie }) => {
      const { workspaceId } = body;

      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // * 워크스페이스 정보 확인
      const { data: workspace } = await supabaseClient
        .from("llami_workspace")
        .select("*")
        .eq("id", workspaceId)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스 예외처리
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
            message: "이미 삭제된 조직입니다.",
          };
        }
      }

      // * 워크스페이스에 속한 사용자인지 확인
      const { data: workspaceMember } = await supabaseClient
        .from("llami_workspace_member")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      // * 워크스페이스에 속한 사용자 예외처리
      if (workspace.owner !== user.id) {
        if (!workspaceMember) {
          return {
            success: false,
            message: "해당 조직에 속한 사용자가 아닙니다.",
          };
        }
      }

      // * 위젯 목록 조회
      const { data: widgets, error } = await supabaseClient
        .from("llami_widget")
        .select("*, files:llami_vector_file_description(*)")
        .eq("workspace_id", workspaceId)
        .eq("is_deleted", false)
        .eq("llami_vector_file_description.is_deleted", false);

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
            files: widget.files.map(({ file_name, id, size, storage_url }) => ({
              src: storage_url,
              name: file_name,
              id: id.toString(),
              size,
            })),
            alter_prompt: widget.alter_prompt ?? null,
            questions: widget.questions as string[] | null,
            animation_theme: widget.animation_theme ?? null,
          })) ?? [],
      };
    },
    {
      detail: {
        tags: ["Widget"],
        description:
          "Retrieve a list of widgets that the access token belongs to.",
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
              files: t.Nullable(
                t.Array(
                  t.Object({
                    src: t.String(),
                    name: t.String(),
                    id: t.String(),
                    size: t.Number(),
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
              accept_contact: t.Nullable(
                t.Boolean({
                  description: "Accept Contact",
                }),
              ),
              category: t.Nullable(
                t.String({
                  description: "Category",
                }),
              ),
              payment_type: t.Nullable(
                t.String({
                  description: "Payment Type",
                }),
              ),
              store_type: t.Nullable(
                t.String({
                  description: "Store Type",
                }),
              ),
            }),
          ),
        ),
      }),
    },
  );
};
