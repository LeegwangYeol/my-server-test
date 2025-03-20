import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { getUser } from "@/src/utils/get-user-from-token";

export const v1WidgetThreadContactList = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread-contact/list",
    async ({ body, cookie }) => {
      const { threadId } = body;
      const user = await getUser({ body, cookie });
      if (!user) {
        return {
          success: false,
          message: "로그인 한 이용자만 사용 가능해요",
        };
      }

      const { data: contacts, error: contactsError } = await supabaseClient
        .from("llami_widget_thread_contact")
        .select("*")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: false });

      if (contactsError) {
        console.error("연락처 정보 조회 중 오류:", contactsError);
        return {
          success: false,
          message: "연락처 정보를 조회하는 중 오류가 발생했어요",
        };
      }

      return {
        success: true,
        message: "연락처 정보를 성공적으로 조회했어요",
        result: contacts || [],
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "특정 위젯의 스레드 연락처 목록을 가져옵니다.",
      },
      body: t.Object({
        threadId: t.String({
          description: "Thread ID",
        }),
        accessToken: t.Optional(
          t.String({
            description: "Access Token",
            error: "Access Token is required",
          }),
        ),
      }),
    },
  );
};
