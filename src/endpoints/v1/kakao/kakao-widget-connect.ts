import { llmApi } from "@/lib/api/llm";
import { Elysia, t } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { isKakaoIP } from "../../../config/kakao";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
export const v1KakaoWidgetConnect = async (app: Elysia<"/v1/kakao">) => {
  app.post(
    "/chatbot/connect/:widgetId",
    async ({ body: { userRequest }, params: { widgetId }, request }) => {
      const ip = request.headers.get("cf-connecting-ip");

      if (!isKakaoIP(ip)) {
        sendPrimaryDiscordWebhook(
          `🚨 카카오IP가아닌 허용되지 않은 IP가 접근하였습니다. ip:${ip}`,
          request,
        );
        return new Response("허용되지 않은 IP에서의 요청입니다.", {
          status: 403,
        });
      }

      const userMessage = userRequest.utterance;
      const callbackUrl = userRequest.callbackUrl;
      console.log(`[Kakao Chatbot] User message: ${userMessage}`);

      const { data: widgetInfo, error } = await supabaseClient
        .from("llami_widget")
        .select("*")
        .eq("id", widgetId)
        .limit(1)
        .maybeSingle();

      {
        if (error) {
          console.error(error);
          throw new Error(
            "네트워크 오류로 인해 문제가 발생했습니다. 잠시 후 다시 시도해주세요, 문제가 지속되면 관리자에게 문의해주세요.",
          );
        }
        if (!widgetInfo) {
          throw new Error("존재하지 않는 위젯입니다.");
        }
      }

      if (widgetInfo) {
        (async () => {
          const answer = await questionToLLM(
            `${userMessage} (답변에 마크다운이나 URL이나 HTML은 사용하지 마세요.)`,
            widgetId,
          );

          // @see https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/ai_chatbot_callback_guide
          const data = {
            version: "2.0",
            template: {
              outputs: [
                {
                  simpleText: {
                    text: answer,
                  },
                },
              ],
            },
          };

          await fetch(callbackUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
          });
        })();

        return {
          version: "2.0",
          useCallback: true,
          data: {
            text: "AI가 답변을 입력 중입니다...",
          },
        };
      } else {
        return {
          version: "2.0",
          useCallback: true,
          data: {
            text: "아직 위젯이 활성화되지 않았습니다. 관리자에게 문의해주세요.",
          },
        };
      }
    },
    {
      detail: {
        tags: ["Kakao"],
        description: "Connect to the Kakao Chatbot API.",
      },
      body: t.Object({
        userRequest: t.Object({
          utterance: t.String({
            description: "User message",
            error: "User message is required",
            minLength: 1,
          }),
          callbackUrl: t.String({
            description: "Callback URL",
            error: "Callback URL is required",
            minLength: 1,
          }),
        }),
      }),
    },
  );
};

export const questionToLLM = async (userMessage: string, widgetId: string) => {
  let responseText: string[] = [];
  let result = "";

  const threadId = await llmApi.createThread(widgetId);
  const texts = await llmApi.ask(
    threadId,
    userMessage,
    new AbortController().signal,
    widgetId,
  );

  if (texts) {
    for await (let event of texts) {
      if (typeof event.data === "string") {
        let streamResponseText = "";
        streamResponseText += event.data
          .replace(/%20/g, " ")
          .replace(/%0a/g, "\n");
        responseText.push(streamResponseText);
      }
    }

    result = removeFunctionCallText(responseText.join(""));
    return result;
  }
  return "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
};

export const removeFunctionCallText = (text: string) => {
  return text
    .replace("[[FUNCTION-CALL]] web-search", "")
    .replace(
      /\[\[FUNCTION-CALL\]\] naver-search .*?\[\[\/FUNCTION-CALL\]\]/g,
      "",
    )
    .replace(
      /\[\[FUNCTION-CALL\]\] google-search .*?\[\[\/FUNCTION-CALL\]\]/g,
      "",
    )
    .replace(/\[\[FUNCTION-CALL\]\] read-link .*?\[\[\/FUNCTION-CALL\]\]/g, "")
    .replace(
      /\[\[FUNCTION-CALL\]\] current-time .*?\[\[\/FUNCTION-CALL\]\]/g,
      "",
    )
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s]+?\)/g, "$1")
    .trim();
};
