/**
 * 회귀 방지용 최소 스모크 테스트 — `bun test` 로 실행.
 *
 * 외부 API·DB 를 건드리지 않는 경로만 검증한다 (Supabase 는 lazy Proxy 라 부팅 시
 * 접속하지 않고, 아래 라우트들은 DB 에 닿기 전에 응답한다).
 *   - /v1/healthz, /v1/heartbeat : 앱이 부팅되고 라우팅이 살아 있는가
 *   - 없는 경로                   : 404
 *   - /v2/admin/* 인증 가드       : 토큰 없으면 401, ADMIN_TOKEN 미설정이면 500(fail-closed)
 *                                   — 보안 감사에서 가장 중요한 불변식. 이게 깨지면
 *                                   admin 11개 엔드포인트가 무방비가 된다.
 *
 * Vercel 서버리스는 `app.handle(Request)` 로 요청을 넘기므로, 여기서도 같은 진입점을 쓴다.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app";

type App = Awaited<ReturnType<typeof createApp>>;

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("app smoke", () => {
  let app: App;
  beforeAll(async () => {
    app = await createApp(true); // serverless=true → listen() 안 함
  });

  it("GET /v1/healthz → 200 OK", async () => {
    const r = await app.handle(req("/v1/healthz"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("OK");
  });

  it("GET /v1/heartbeat → alive JSON", async () => {
    const r = await app.handle(req("/v1/heartbeat"));
    expect(r.status).toBe(200);
    const d = (await r.json()) as { status?: string; timestamp?: string };
    expect(d.status).toBe("alive");
    expect(typeof d.timestamp).toBe("string");
  });

  it("unknown route → 404", async () => {
    const r = await app.handle(req("/v2/definitely-not-a-route"));
    expect(r.status).toBe(404);
  });

  it("GET / → 200 Swagger/Scalar documentation", async () => {
    const r = await app.handle(req("/"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("API Reference");
  });

  it("GET /json → 200 OpenAPI 3.0 spec", async () => {
    const r = await app.handle(req("/json"));
    expect(r.status).toBe(200);
    const spec = (await r.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toBeDefined();
  });

  it("GET /api/hello → 200 platform sanity parity", async () => {
    const r = await app.handle(req("/api/hello"));
    expect(r.status).toBe(200);
    const d = (await r.json()) as { message?: string };
    expect(d.message).toBe("hello from vercel");
  });
});

describe("admin guard is fail-closed & timing safe", () => {
  const saved = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = saved;
  });

  it("no x-admin-token → 401", async () => {
    process.env.ADMIN_TOKEN = "test-token-for-guard";
    const app = await createApp(true);
    const r = await app.handle(json("/v2/admin/widgets", {}));
    expect(r.status).toBe(401);
    const d = (await r.json()) as { success?: boolean };
    expect(d.success).toBe(false);
  });

  it("wrong x-admin-token → 401", async () => {
    process.env.ADMIN_TOKEN = "test-token-for-guard";
    const app = await createApp(true);
    const r = await app.handle(
      json("/v2/admin/widgets", {}, { "x-admin-token": "nope" }),
    );
    expect(r.status).toBe(401);
  });

  it("ADMIN_TOKEN unset → 500 (refuses to run rather than opening up)", async () => {
    delete process.env.ADMIN_TOKEN;
    const app = await createApp(true);
    // body 는 Elysia 스키마를 통과해야 가드까지 도달한다.
    const r = await app.handle(
      json("/v2/admin/sms/send", { to: "01000000000", text: "x" }),
    );
    expect(r.status).toBe(500);
    const d = (await r.json()) as { success?: boolean; error?: string };
    expect(d.success).toBe(false);
    expect(d.error).toContain("ADMIN_TOKEN");
  });
});

describe("YouTube error status schema validation (no 422 ResponseValidationError)", () => {
  it("POST /v1/youtube/channel/info with invalid token returns 400 (not 422)", async () => {
    const app = await createApp(true);
    const r = await app.handle(
      json("/v1/youtube/channel/info", { accessToken: "invalid-dummy-token" }),
    );
    // Should be 400 Bad Request, NOT 422 ResponseValidationError
    expect(r.status).toBe(400);
    const d = (await r.json()) as { success?: boolean; message?: string };
    expect(d.success).toBe(false);
    expect(d.message).toBeDefined();
  });

  it("POST /v1/youtube/video/list with invalid token returns 400 (not 422)", async () => {
    const app = await createApp(true);
    const r = await app.handle(
      json("/v1/youtube/video/list", { handle: "invalid_handle", accessToken: "invalid-token" }),
    );
    expect(r.status).toBe(400);
    const d = (await r.json()) as { success?: boolean };
    expect(d.success).toBe(false);
  });
});
