import Elysia, { t } from "elysia";

// 프로세스 시작 시각 — 콜드 스타트마다 새로 계산되지만 동일 인스턴스 동안의 uptime 측정용
const processStartedAt = Date.now();

// 타입 단언을 사용하여 타입 오류 해결
export const healthzEndpoint = async (app: any) => {
  app.group("/v1", (app: any) => {
    app.get(
      "/healthz",
      async () => {
        return "OK";
      },
      {
        detail: {
          tags: ["Health"],
          description: "Health check endpoint (단순 liveness 체크)",
        },
        response: t.String({
          description: "Health check response",
          example: "OK",
        }),
      },
    );

    app.get(
      "/heartbeat",
      async () => {
        const now = Date.now();
        return {
          status: "alive",
          timestamp: new Date(now).toISOString(),
          uptimeMs: now - processStartedAt,
          uptimeSec: Math.floor((now - processStartedAt) / 1000),
          processUptimeSec: Math.floor(process.uptime()),
          node: process.version,
          region: process.env.VERCEL_REGION ?? null,
          env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
          deploymentUrl: process.env.VERCEL_URL ?? null,
          commitSha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        };
      },
      {
        detail: {
          tags: ["Health"],
          description:
            "구조화된 heartbeat — 외부 모니터(uptime checker 등)용. " +
            "uptimeMs는 현재 lambda 인스턴스 기준이라 cold start마다 리셋됨.",
        },
        response: t.Object({
          status: t.String({ example: "alive" }),
          timestamp: t.String({ example: "2026-01-01T00:00:00.000Z" }),
          uptimeMs: t.Number(),
          uptimeSec: t.Number(),
          processUptimeSec: t.Number(),
          node: t.String({ example: "v20.20.2" }),
          region: t.Union([t.String(), t.Null()]),
          env: t.String(),
          deploymentUrl: t.Union([t.String(), t.Null()]),
          commitSha: t.Union([t.String(), t.Null()]),
        }),
      },
    );

    return app;
  });
};
