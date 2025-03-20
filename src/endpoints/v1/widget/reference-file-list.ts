import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";
import { Elysia, t } from "elysia";

export const v1WidgetReferenceFileList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/reference-file/list",
    async ({ body, cookie }) => {
      const { widgetId } = body;

      // 사용자 인증
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용가능합니다.",
        };
      }

      // 데이터베이스에서 파일 가져오기
      const { data: files, error } = await supabaseClient
        .from("llami_vector_file_description")
        .select("*")
        .eq("widget_id", widgetId)
        .eq("is_deleted", false)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Error fetching files:", error);
        return {
          success: false,
          message: "파일 목록을 가져오는 중 오류가 발생했습니다.",
        };
      }

      return {
        success: true,
        message: "파일 목록을 가져왔습니다.",
        files:
          files.map(({ id, storage_url, file_name, size }) => ({
            id: id.toString(),
            src: storage_url,
            name: file_name,
            size,
          })) || [],
      };
    },
    {
      detail: {
        tags: ["Widget Reference File"],
        description: "특정 위젯의 참조 파일 목록을 가져옵니다.",
      },
      body: t.Object({
        accessToken: t.Optional(
          t.String({
            description: "액세스 토큰",
            error: "Access Token is required",
          }),
        ),
        widgetId: t.String({
          description: "위젯 ID",
          error: "Widget ID is required",
        }),
      }),
      response: t.Object({
        success: t.Boolean({
          description: "성공 여부",
        }),
        files: t.Optional(
          t.Array(
            t.Object({
              id: t.String(),
              src: t.String(),
              name: t.String(),
              size: t.Number(),
            }),
          ),
        ),
        message: t.Optional(
          t.String({
            description: "에러 메시지",
          }),
        ),
      }),
    },
  );
};
