import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { writeWorkspaceLog } from "@/src/utils/log/discord-logger";
import { getUser } from "@/src/utils/get-user-from-token";
import { storeFileEmbedding } from "@/lib/vector/store-file-embedding";
import { voyage } from "@/lib/ai/voyage";

export const v1WidgetUpdate = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/update",
    async ({ body, cookie, request }) => {
      const { workspaceId } = body;
      const { images, files, ...widget } = body.widget;

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

      if (widget.id) {
        // * 위젯 정보 확인
        const { data: alreadyExistWidgetData } = await supabaseClient
          .from("llami_widget")
          .select("*")
          .eq("id", widget.id)
          .limit(1)
          .maybeSingle();

        // * 위젯 예외처리
        {
          if (!alreadyExistWidgetData) {
            return {
              success: false,
              message: "존재하지 않는 위젯입니다.",
            };
          }
          if (alreadyExistWidgetData.workspace_id !== workspaceId) {
            return {
              success: false,
              message: "조직에 속하지 않는 위젯입니다.",
            };
          }
          if (alreadyExistWidgetData.is_deleted) {
            return {
              success: false,
              message: "해당 위젯은 삭제된 위젯입니다.",
            };
          }
        }

        // * 이미지 처리 로직 추가
        if (images) {
          // 기존 이미지 데이터 조회
          const { data: existingImages } = await supabaseClient
            .from("llami_widget_reference_image")
            .select("*")
            .eq("widget_id", widget.id)
            .eq("is_deleted", false);

          // 이미지 임베딩
          const imageEmbeddings = await voyage.embeddings({
            model: "voyage-3-lite",
            texts: images.map((image) => image.description),
          });

          // 삭제할 이미지 필터링
          const imagesToDelete = existingImages?.filter(
            (existing) => !images?.find((img) => img.id === existing.id),
          );

          // 이미지 처리 작업 병렬 실행
          await Promise.all([
            // 삭제 처리
            ...(imagesToDelete?.map((image) =>
              supabaseClient
                .from("llami_widget_reference_image")
                .update({ is_deleted: true })
                .eq("id", image.id),
            ) || []),

            ...images.map((image, index) => {
              if (image.id == null) {
                return supabaseClient
                  .from("llami_widget_reference_image")
                  .insert({
                    widget_id: widget.id,
                    src: image.src,
                    description: image.description || "",
                    embedding:
                      imageEmbeddings.object === "list"
                        ? JSON.stringify(imageEmbeddings.data[index].embedding)
                        : undefined,
                    model:
                      imageEmbeddings.object === "list"
                        ? "voyage-3-lite"
                        : undefined,
                  });
              }

              if (image.id) {
                return supabaseClient
                  .from("llami_widget_reference_image")
                  .update({
                    src: image.src,
                    description: image.description || "",
                    embedding:
                      imageEmbeddings.object === "list"
                        ? JSON.stringify(imageEmbeddings.data[index].embedding)
                        : undefined,
                    model:
                      imageEmbeddings.object === "list"
                        ? "voyage-3-lite"
                        : undefined,
                  })
                  .eq("id", image.id);
              }
            }),
          ]);
        }

        if (files) {
          const { data: existingFiles } = await supabaseClient
            .from("llami_vector_file_description")
            .select("*")
            .eq("widget_id", widget.id)
            .eq("is_deleted", false);

          const filesToDelete = existingFiles?.filter(
            (existing) =>
              !files?.find((file) => file.id === existing.id.toString()),
          );

          await Promise.all([
            // 삭제 처리
            ...(filesToDelete?.map((file) =>
              supabaseClient
                .from("llami_vector_file_description")
                .update({ is_deleted: true })
                .eq("id", file.id),
            ) || []),

            // 신규 추가 (id가 falsy한 값인 경우)
            ...files
              .filter((file) => !file.id)
              .map(async ({ src, name }) => {
                storeFileEmbedding(src, name, widget.id!);
              }),
          ]);
        }

        // * 위젯 갱신
        const { data: _, error: widgetUpdateError } = await supabaseClient
          .from("llami_widget")
          .update({
            ...widget,
          })
          .match({ id: widget.id })
          .select();

        // * 위젯 갱신 예외처리
        if (widgetUpdateError) {
          console.error(widgetUpdateError);
          return {
            success: false,
            message:
              "위젯 갱신에 실패했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
          };
        }

        // * 위젯 갱신 로그 전송
        writeWorkspaceLog(
          {
            code: "UPDATE_WIDGET",
            message: `🔖 **${workspace.name ?? "개인계정"}** 조직에 **${
              widget.name
            }** 위젯의 정보를 갱신하였습니다.\n> **${user.phone_number}**님이 해당 위젯 정보를 갱신하였습니다.`,
            issued_user_id: user.id,
            workspace_id: workspaceId,
          },
          request,
        );

        return {
          success: true,
          message: "위젯 정보가 갱신되었습니다.",
        };
      } else {
        // * 위젯 생성
        const response = await supabaseClient
          .from("llami_widget")
          .insert({
            ...widget,
            workspace_id: workspaceId,
          })
          .select("*")
          .limit(1)
          .maybeSingle();

        // * 위젯 예외처리
        if (response.error) {
          console.error(response.error);
          return {
            success: false,
            message:
              "위젯 생성에 실패했습니다. 잠시 후 다시 시도해주세요. 문제가 지속될 경우 관리자에게 문의해주세요.",
          };
        }

        // * 이미지 처리 로직 추가
        if (images) {
          await Promise.all(
            images.map((image) =>
              supabaseClient.from("llami_widget_reference_image").insert({
                widget_id: response.data!.id,
                src: image.src,
                description: image.description || "",
              }),
            ),
          );
        }

        if (files) {
          await Promise.all(
            files.map(async ({ src, name }) => {
              storeFileEmbedding(src, name, response.data!.id);
            }),
          );
        }

        // * 위젯 생성 로그 전송
        writeWorkspaceLog(
          {
            code: "CREATE_WIDGET",
            message: `🎉 **${workspace.name ?? "개인계정"}** 조직에 **${widget.name}** 위젯을 생성하였습니다.\n> **${
              user.phone_number
            }**님이 해당 위젯을 생성하였습니다.`,
            issued_user_id: user.id,
            workspace_id: workspaceId,
          },
          request,
        );

        return {
          success: true,
          message: "위젯이 생성되었습니다.",
        };
      }
    },
    {
      detail: {
        tags: ["Widget"],
        description:
          "Create or update a widget. If the widget ID is provided, the widget will be updated. Otherwise, a new widget will be created.",
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
        }),
        widget: t.Object({
          id: t.Optional(
            t.String({
              description: "Widget ID",
            }),
          ),
          category: t.Optional(
            t.String({
              description: "Widget Category",
            }),
          ),
          name: t.String({
            description: "Name",
            error: "Name is required",
          }),
          description: t.String({
            description: "Description",
            error: "Description is required",
          }),
          avatar_src: t.Optional(
            t.String({
              description: "Avatar Src",
            }),
          ),
          theme: t.String({
            description: "Widget Theme",
            error: "Widget Theme is required",
          }),
          animation_theme: t.Optional(
            t.String({
              description: "Widget Animation Theme",
            }),
          ),
          prompt: t.String({
            description: "Prompt",
            error: "Prompt is required",
          }),
          payment_type: t.Optional(
            t.String({
              description: "Payment Type",
            }),
          ),
          alter_prompt: t.String({
            description: "Alter Prompt",
            error: "Alter Prompt is required",
          }),
          widget_message_title: t.String({
            description: "Widget Message Title",
            error: "Widget Message Title is required",
          }),
          widget_message_content: t.String({
            description: "Widget Message Content",
            error: "Widget Message Content is required",
          }),
          widget_margin_right: t.Number({
            description: "Widget Margin Right",
            error: "Widget Margin Right is required",
          }),
          widget_margin_bottom: t.Number({
            description: "Widget Margin Bottom",
            error: "Widget Margin Bottom is required",
          }),
          questions: t.Array(
            t.String({
              description: "Default Questions",
              error: "Default Questions is required",
            }),
          ),
          files: t.Optional(
            t.Array(
              t.Object({
                id: t.Optional(
                  t.String({
                    description: "File id",
                  }),
                ),
                name: t.String({
                  description: "File Name",
                }),
                src: t.String({
                  description: "File URL",
                }),
                size: t.Number({
                  description: "File Size",
                }),
              }),
            ),
          ),
          widget_auto_open: t.Boolean({
            description: "Widget Auto Open",
            error: "Widget Auto Open is required",
          }),
          welcome_message: t.String({
            description: "Welcome Message",
            error: "Welcome Message is required",
          }),
          images: t.Optional(
            t.Array(
              t.Object({
                id: t.Optional(
                  t.String({
                    description: "Image id",
                  }),
                ),
                src: t.String({
                  description: "Image src",
                }),
                description: t.String({
                  description: "Image description",
                }),
              }),
            ),
          ),
          font_family: t.Optional(
            t.Nullable(
              t.String({
                description: "Font Family",
                error: "Font Family is required",
              }),
            ),
          ),
          icon: t.Optional(
            t.Nullable(
              t.String({
                description: "chatbot custom image icon",
                error: "Icon is required",
              }),
            ),
          ),
          logo: t.Optional(
            t.String({
              description: "chatbot custom image logo URL",
              error: "Invalid logo URL format",
            }),
          ),
          accept_contact: t.Optional(
            t.Boolean({
              description: "Accept Contact",
              error: "Accept Contact is required",
            }),
          ),
          store_type: t.Optional(
            t.Nullable(
              t.String({
                description: "Store Type",
                error: "Store Type is required",
              }),
            ),
          ),
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
