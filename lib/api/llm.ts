import { stream } from "fetch-event-stream";

export const llmApi = {
  baseUrl: "https://api-llm.llami.net",
  createThread: async (widgetId: string) => {
    const response = await fetch(`${llmApi.baseUrl}/v2/widget/create-thread`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        widgetId,
      }),
    });

    return (await response.json()).threadId;
  },
  ask: async (
    threadId: string,
    message: string,
    signal: AbortSignal,
    widgetId: string,
  ) => {
    const events = await stream(`${llmApi.baseUrl}/v2/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        threadId,
        widgetId,
        browserInfo: {},
      }),
      signal,
    });

    return events;
  },
  reply: async (text: string) => {
    const url = `${llmApi.baseUrl}/v1/sound/tts`;
    const response = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        voice: "onyx",
        model: "tts-1",
        responseFormat: "mp3",
      }),
    });

    return URL.createObjectURL(await response.then((res) => res.blob()));
  },
};
