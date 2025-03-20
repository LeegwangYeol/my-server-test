import { Elysia } from "elysia";
import { supabaseClient } from "@/lib/supabase/client";
import { questionToLLM } from "../../kakao/chatbot-connect";

// 타입 정의
interface WebhookQuery {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
}

const MAX_RESPONSE_LENGTH = 1800;

const truncateToNearestSentence = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;

  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastQuestion = truncated.lastIndexOf("?");
  const lastExclamation = truncated.lastIndexOf("!");

  const lastBoundary = Math.max(lastPeriod, lastQuestion, lastExclamation);

  if (lastBoundary === -1) {
    return truncated.trim() + "...";
  }

  return text.substring(0, lastBoundary + 1).trim();
};

/**
 * @see https://github.com/fbsamples/original-coast-clothing/blob/main/app.js
 */
export const v1SocialInstagramWebhook = async (app: Elysia<"/v1/social">) => {
  app.get(
    "/instagram/webhook",
    ({ query, set }) => {
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      if (mode && token) {
        if (
          mode === "subscribe" &&
          token === process.env.INSTAGRAM_VERIFY_TOKEN
        ) {
          set.status = 200;
          return challenge;
        } else {
          // set.status = 403;
          // return "Forbidden";
          set.status = 200;
          return challenge;
        }
      }
    },
    {
      detail: {
        tags: ["Social"],
        description: "Social OAuth endpoint",
      },
    },
  );

  app.post(
    "/instagram/webhook",
    async ({ request, set }) => {
      const body = await request.json();
      if (body.object === "instagram") {
        for (let i = 0; i < body.entry.length; i++) {
          const entry = body.entry[i];
          const messagingEvent = entry.messaging[0];
          if (messagingEvent.message && messagingEvent.message.text) {
            // @reference https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/
            const senderId = messagingEvent.sender.id;
            const recipientId = messagingEvent.recipient.id;
            const messageText = messagingEvent.message.text;
            const timestamp = messagingEvent.timestamp;

            const isEcho = messagingEvent.message.is_echo;
            const isUnsupported = messagingEvent.message.is_unsupported;
            const isDeleted = messagingEvent.message.is_deleted;

            // 예외처리
            {
              // 메시지가 자신이 보낸 메시지일경우 무시
              if (isEcho) {
                console.log(`내가 보낸 메세지가 확인되었습니다.`, {
                  senderId,
                  recipientId,
                  messageText,
                  timestamp,
                });
                return;
              }
              // 지원하지 않는 메시지일 경우 무시
              if (isUnsupported) {
                console.log(`지원하지 않는 메세지가 확인되었습니다.`, {
                  senderId,
                  recipientId,
                  messageText,
                  timestamp,
                });
                return;
              }
              // 삭제된 메시지일 경우 무시
              if (isDeleted) {
                console.log(`삭제된 메세지가 확인되었습니다.`, {
                  senderId,
                  recipientId,
                  messageText,
                  timestamp,
                });
                return;
              }
            }

            if (senderId && messageText) {
              // 인스타그램 메세지를 받았을 때
              console.log("인스타그램 메세지를 받았습니다:", {
                senderId,
                recipientId,
                messageText,
                timestamp,
              });

              // TODO 라미챗에 등록된 계정인지 확인하기
              const is_activated = true;
              if (is_activated) {
                // * recipientId 를 토대로 access token 을 얻어오기
                let { data: businessAccount } = await supabaseClient
                  .from("llami_chat_oauth_token")
                  .select("*")
                  .eq("business_id", recipientId)
                  .limit(1)
                  .maybeSingle();

                // * 예외처리
                {
                  // * businessAccount 가 존재하지 않을 경우
                  if (!businessAccount) {
                    console.error(
                      `인스타그램 비즈니스 계정이 아니거나 라미챗에 등록된 계정이 아닙니다. (ID: ${recipientId})`,
                    );
                    return {
                      success: false,
                      error: "Not a business account or LLAMI Chat account",
                    };
                  }

                  // * updated_at 이 없을 경우
                  if (!businessAccount.updated_at) {
                    // * updated_at 업데이트
                    await supabaseClient.from("llami_chat_oauth_token").update({
                      business_id: recipientId,
                      business_type: "instagram",
                      updated_at: new Date().toISOString(),
                    });
                  }

                  // * updated_at 이 24시간이 지났을 경우
                  if (businessAccount.updated_at) {
                    const currentTime = new Date().getTime();
                    const updatedAt = new Date(
                      businessAccount.updated_at,
                    ).getTime();
                    const diff = Math.abs(currentTime - updatedAt);
                    if (diff > 1000 * 60 * 60 * 24) {
                      // * 인스타그램 토큰 갱신
                      const response = await fetch(
                        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${businessAccount.token}`,
                        {
                          method: "GET",
                        },
                      );

                      // * 예외처리
                      {
                        if (!response.ok) {
                          console.error(
                            `인스타그램 토큰 갱신에 실패했습니다. (ID: ${recipientId})`,
                          );
                          // * 에러 메세지 표시
                          console.log("인스타그램 에러:", response.statusText);
                        }
                      }

                      const { access_token } = ((await response.json()) ??
                        {}) as {
                        access_token: "<LONG_LIVED_ACCESS_TOKEN>";
                        token_type: "bearer";
                        expires_in: 5183944; // Number of seconds until token expires
                      };

                      if (access_token) {
                        // * updated_at 이랑 저장된 토큰 업데이트
                        const { data, error } = await supabaseClient
                          .from("llami_chat_oauth_token")
                          .update({
                            updated_at: new Date().toISOString(),
                            token: access_token,
                          })
                          .eq("business_id", recipientId)
                          .eq("business_type", "instagram")
                          .select("*")
                          .order("created_at", { ascending: false })
                          .limit(1)
                          .maybeSingle();

                        // * 예외처리
                        {
                          if (error) {
                            console.error(
                              `인스타그램 토큰 갱신에 실패했습니다. (ID: ${recipientId})`,
                            );
                            // * 에러 메세지 표시
                            console.log("수파베이스 에러:", error);
                          }
                        }

                        // * businessAccount 업데이트
                        if (!data) {
                          console.error(
                            `인스타그램 토큰 갱신에 실패했습니다. (ID: ${recipientId})`,
                          );
                          // * 에러 메세지 표시
                          console.log("수파베이스 에러:", "Data is empty");
                        } else {
                          businessAccount = data;
                        }
                      }
                    }
                  }
                }

                // * 라미챗 위젯 확인
                const widgetId = businessAccount.widget_id;
                if (!widgetId) {
                  set.status = 400;
                  return "No Widget ID";
                }

                // * 위젯 정보 가져오기
                const { data: widgetInfo, error } = await supabaseClient
                  .from("llami_widget")
                  .select("*")
                  .eq("id", widgetId)
                  .limit(1)
                  .maybeSingle();

                // * 예외처리
                {
                  // * 에러가 발생했을 경우
                  if (error) {
                    console.error(error);
                    throw new Error(
                      "네트워크 오류로 인해 문제가 발생했습니다. 잠시 후 다시 시도해주세요, 문제가 지속되면 관리자에게 문의해주세요.",
                    );
                  }

                  // * 위젯 정보가 없을 경우
                  if (!widgetInfo) {
                    set.status = 400;
                    return "No Widget";
                  }

                  // * 위젯이 활성화 되어있지 않을 경우
                  if (widgetInfo.is_deleted) {
                    set.status = 400;
                    return "Widget is not active";
                  }
                }

                // * AI 답변 생성
                const answer = await questionToLLM(
                  `${
                    messageText
                  } (Don't use markdown or HTML in your answers. Images should be URL links only. Don't use markdown. Answer in the user's language. Generally, use English.
And keep your answers as short as possible)`,
                  widgetId,
                );

                // * 답변 메세지 전송
                // * 텍스트 전처리 함수
                const sanitizeMessage = (text: string): string => {
                  // 1. null이나 undefined 체크
                  if (!text) return "";

                  // 2. 문자열로 변환
                  const stringText = String(text);

                  // 3. 특수문자 및 이모지 처리
                  const sanitized = stringText
                    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "") // 이모지 제거
                    .replace(/[^\x20-\x7E\n\r\t가-힣]/g, "") // 기본 ASCII와 한글만 허용
                    .trim();

                  // 4. 빈 문자열 체크
                  if (!sanitized) {
                    return "메시지를 처리할 수 없습니다.";
                  }

                  return truncateToNearestSentence(
                    sanitized,
                    MAX_RESPONSE_LENGTH,
                  );
                };

                // * 답변 메세지 전송
                try {
                  const sanitizedAnswer = `[AI] ${sanitizeMessage(
                    Array.isArray(answer) ? answer[0] : answer,
                  )}`;

                  // 디버깅을 위한 로그
                  console.log("답변 메세지를 보냈습니다.", {
                    original: answer,
                    sanitized: sanitizedAnswer,
                    length: sanitizedAnswer.length,
                  });

                  const response = await fetch(
                    `https://graph.instagram.com/v21.0/${recipientId}/messages`,
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${businessAccount.token}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        recipient: {
                          id: senderId,
                        },
                        message: {
                          text: sanitizedAnswer,
                        },
                      }),
                    },
                  );

                  // API 응답이 성공적이지 않은 경우를 처리
                  if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error("Instagram API Error:", {
                      status: response.status,
                      statusText: response.statusText,
                      error: errorData,
                      sentText: sanitizedAnswer, // 실패한 텍스트 로깅
                    });
                    throw new Error(
                      `Failed to send message: ${response.statusText}`,
                    );
                  }
                } catch (error) {
                  console.error("Failed to send Instagram message:", {
                    recipientId,
                    senderId,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Unknown error occurred",
                  });
                  throw error;
                }
              }
            } else {
              set.status = 404;
              return "Not Found";
            }
          }
        }
      }
    },
    {
      detail: {
        tags: ["Social"],
        description: "Social OAuth endpoint",
      },
    },
  );
};
