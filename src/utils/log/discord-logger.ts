import { supabaseClient } from "@/lib/supabase/client";
import chalk from "chalk";

const discordWebhookUrl =
  "https://discord.com/api/webhooks/1292998851283779686/7Ro17Q3J-EE9Vnq9VFqUZQl-q-9c8frT9urn7iUf9SpvloToJJbejG2i8DplipbKK1DN";

const sendPrimaryWebhookUrl =
  "https://discord.com/api/webhooks/1297795807768219770/xUKnnWdixla19UaiDR2etL2ZGiAotZLbY81RgM8yy7bBCbDvG9Y4frIXs-hcCYH_Xj61";

export interface WriteWorkspaceLogProps {
  code: string;
  message: string;
  workspace_id: string;
  issued_user_id: string;
}

const getClientIP = (request: Request): string => {
  if (!request) return "No Request Info";

  // Cloudflare headers
  const cfIP = request.headers.get("cf-connecting-ip");
  const realIP = request.headers.get("x-real-ip");
  const forwardedFor = request.headers.get("x-forwarded-for");
  const location = request.headers.get("cf-ipcountry");
  const userAgent = request.headers.get("user-agent");
  const referer = request.headers.get("referer");

  // Local development - use host or origin
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");

  const result =
    cfIP ||
    realIP ||
    location ||
    userAgent ||
    referer ||
    forwardedFor ||
    host ||
    (origin ? new URL(origin).hostname : "Unknown IP");
  return result;
};

export const sendDiscordWebhook = async (message: string, request: Request) => {
  const clientIP = getClientIP(request);
  const messageWithIP = `${message}\n> Request IP: ${clientIP}`;

  try {
    await fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageWithIP }),
    });
  } catch (e) {}
};

export const sendPrimaryDiscordWebhook = async (
  message: string,
  request: Request,
) => {
  const clientIP = getClientIP(request);
  const messageWithIP = `${message}\n> Request IP: ${clientIP}`;

  try {
    await fetch(sendPrimaryWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageWithIP }),
    });
  } catch (e) {}
};

export const writeWorkspaceLog = (
  data: WriteWorkspaceLogProps,
  request: Request,
) => {
  // * 워크스페이스 로그 작성
  // ! hmmhmmhm: 의도된 개별 async 처리입니다. 서버 응답이 로깅 과정에 의해 지연되어서는 안 됩니다.
  (async () => {
    try {
      const response = await supabaseClient
        .from("llami_workspace_log")
        .insert({ ...data });

      // * 디스코드 및 콘솔 로깅
      if (!response.error) {
        console.log(chalk.green(`[WORKSPACE] [${data.code}] ${data.message}`));

        await sendDiscordWebhook(data.message, request);
      } else {
        console.error(
          chalk.red(
            `[Workspace] Logging Error: "${response.error.message}" Origin Log: [${data.code}] ${data.message}`,
          ),
        );
      }
    } catch (e) {}
  })();
};
