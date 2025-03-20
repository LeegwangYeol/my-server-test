import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";

export const v1WidgetThreadContact = async (app: Elysia<"/v1/widget">) => {
  app.post(
    "/thread/create-contact",
    async ({ body }) => {
      const { threadId, note, contact } = body;

      // * 스레드 정보 확인
      const { data: thread, error: threadError } = await supabaseClient
        .from("llami_widget_thread")
        .select("*")
        .eq("id", threadId)
        .limit(1)
        .maybeSingle();
      3;
      if (threadError || !thread) {
        console.error("대화 스레드 정보 확인 중 오류:", threadError);

        return {
          success: false,
          message: "대화 스레드의 정보를 못찾았어요.",
        };
      }

      // * 연락처 정보 저장
      const { data: contactData, error: contactError } = await supabaseClient
        .from("llami_widget_thread_contact")
        .insert({
          thread_id: threadId,
          note,
          contact,
        })
        .select()
        .single();

      if (contactError || !contactData) {
        console.error("연락처 정보 저장 중 오류:", contactError);
        return {
          success: false,
          message: "문의 내용을 전송 중 오류가 발생했어요 ",
        };
      }

      return {
        success: true,
        message: "문의를 성공적으로 요청했어요.",
        result: {
          id: contactData.id,
          thread_id: contactData.thread_id,
          note: contactData.note,
          contact: contactData.contact,
          created_at: contactData.created_at,
        },
      };
    },
    {
      detail: {
        tags: ["Widget Thread"],
        description: "Save contact information for a thread",
      },
      body: t.Object({
        threadId: t.String({
          description: "대화 스레드 ID",
          error: "대화 스레드 ID는 필수입니다.",
        }),
        note: t.Optional(
          t.String({
            description:
              "전화로 받을지, 문자로 받을지 등등을 지정하는 메모란입니다.",
          }),
        ),
        contact: t.String({
          description: "전화 및 이메일의 값입니다.",
          error: "전화 혹은 이메일은 필수입니다.",
        }),
      }),
      response: t.Object({
        success: t.Boolean(),
        message: t.Optional(t.String()),
        result: t.Optional(
          t.Object({
            id: t.String(),
            thread_id: t.String(),
            note: t.String(),
            contact: t.String(),
            created_at: t.String(),
          }),
        ),
      }),
    },
  );

  return app;
};
