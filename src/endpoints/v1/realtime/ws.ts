import { RealtimeClient } from "../../../../lib/real-time";
import { OPEN_AI_API_KEY } from "../../../../lib/api-key";
import { Elysia, t } from "elysia";

// 각 WebSocket 연결별 데이터를 저장할 인터페이스
interface RealtimeWebSocketData {
  client: RealtimeClient;
  messageQueue: string[];
}

// 각 WebSocket 연결별 데이터를 저장할 Map 생성
const sharedData = new Map<string, RealtimeWebSocketData>();

export const v1RealtimeEndpoint = async (app: Elysia) => {
  return app.ws("/v1/realtime/ws", {
    async open(ws) {
      const client = new RealtimeClient({ apiKey: OPEN_AI_API_KEY });

      // OpenAI에서 오는 메시지를 클라이언트로 전달
      client.realtime.on("server.*", (event: any) => {
        ws.send(JSON.stringify(event));
      });
      client.realtime.on("close", () => ws.close());

      // 메시지 큐 생성 (OpenAI 연결 전 메시지 보관)
      const messageQueue: string[] = [];

      // 현재 연결에 대한 데이터 저장
      sharedData.set(ws.id, { client, messageQueue });

      try {
        await client.connect();
        // 대기 중인 메시지 처리
        const wsData = sharedData.get(ws.id);
        if (wsData) {
          while (wsData.messageQueue.length > 0) {
            const data = wsData.messageQueue.shift();
            if (data) {
              processClientMessage(ws, data);
            }
          }
        }
      } catch (e: any) {
        console.log(`Error connecting to OpenAI: ${e.message}`);
        ws.close();
      }
    },
    message(ws, data) {
      processClientMessage(ws, data as string);
    },
    close(ws) {
      const wsData = sharedData.get(ws.id);
      if (wsData && wsData.client) {
        wsData.client.disconnect();
      }
      sharedData.delete(ws.id);
    },
  });
};

// 클라이언트로부터 받은 메시지를 OpenAI로 전달하는 함수
function processClientMessage(ws: any, data: string) {
  const wsData = sharedData.get(ws.id);

  if (!wsData) {
    console.error("wsData not found");
    return;
  }

  const client = wsData.client;

  if (!client.isConnected()) {
    // 아직 OpenAI와 연결되지 않았다면 메시지 큐에 저장
    wsData.messageQueue.push(data);
  } else {
    // OpenAI Realtime API로 메시지 전달
    try {
      const event = typeof data === "string" ? JSON.parse(data) : data;
      client.realtime.send(event.type, event);
    } catch (e: any) {
      console.error(e.message);
      console.log(`Error parsing event from client: ${data}`);
    }
  }
}
