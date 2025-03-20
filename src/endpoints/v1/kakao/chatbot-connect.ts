import { llmApi } from "@/lib/api/llm";
import { Elysia, t } from "elysia";
import { isKakaoIP } from "../../../config/kakao";
import { sendPrimaryDiscordWebhook } from "@/src/utils/log/discord-logger";
export const v1ChatbotConnect = async (app: Elysia<"/v1/kakao">) => {
  app.post(
    "/chatbot/connect",
    async ({ body: { userRequest }, request }) => {
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
      const widgetId = "3c945148-a71a-4be8-8d7d-8b774ccdd416";
      (async () => {
        // LLM을 아래 라인에서부터 호출합니다.
        const [answerText, answerImages] = await questionToLLM(
          `${userMessage} (답변에 마크다운이나 URL이나 HTML은 사용하지 마세요.)`,
          widgetId,
        );

        console.log(`[Kakao Chatbot] Answer text: ${answerText}`);
        answerImages &&
          console.log(`[Kakao Chatbot] Answer images: ${answerImages}`);

        // @see https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/ai_chatbot_callback_guide
        const data = {
          version: "2.0",
          template: {
            outputs: [
              {
                simpleText: {
                  text: answerText,
                },
              },
              ...(answerImages || [])
                .slice(0, 2)
                .map(({ imageUrl, altText }) => ({
                  simpleImage: {
                    imageUrl,
                    altText,
                  },
                })),
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

export const questionToLLM = async (
  userMessage: string,
  paramWidgetId: string,
): Promise<
  [
    text: string,
    images?: {
      imageUrl: string;
      altText: string;
    }[],
  ]
> => {
  let responseText: string[] = [];
  let result = "";

  const widgetId = paramWidgetId;
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

    result = responseText.join("");
    return [removeFunctionCallText(result), parseImages(result)];
  }

  return ["네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요."];
};

export const parseImages = (
  text: string,
): {
  imageUrl: string;
  altText: string;
}[] => {
  const imgRegex = /<img\s*src="(.*?)"\s*alt="(.*?)"\s*\/>/g;
  const imgMatches = text.matchAll(imgRegex);

  const markdownImgRegex = /!\[(.*?)\]\((.*?)\)/g;
  const markdownImgMatches = text.matchAll(markdownImgRegex);

  // match second paren (src)
  const images = [
    ...[...imgMatches].map((match) => ({
      imageUrl: match[1],
      altText: match[2],
    })),
    ...[...markdownImgMatches].map((match) => ({
      imageUrl: match[2],
      altText: match[1],
    })),
  ];

  return images;
};

export const removeFunctionCallText = (text: string) => {
  return text
    .replaceAll(
      /\[\[FUNCTION-CALL\]\]\s*(.*?)\s*\((.*?)\)\s*\[\[\/FUNCTION-CALL\]\]/g,
      "",
    )
    .replace(/<img\s*src="(.*?)"\s*alt="(.*?)"\s*\/>/g, "")
    .replace(/!\[(.*?)\]\((.*?)\)/g, "")
    .trim();
};
