import { createApp } from "../src/app";

interface TestResult {
  endpoint: string;
  method: string;
  target: "local" | "remote";
  status: number;
  expectedStatus: number | number[];
  durationMs: number;
  passed: boolean;
  notes?: string;
}

const REMOTE_BASE = "https://my-server-test.vercel.app";

async function runLocalAndRemoteAudit() {
  console.log("==================================================================");
  console.log("🌅 MORNING AUDIT: DYNAMIC MAPPING & SEQUENTIAL VERIFICATION 🌅");
  console.log("==================================================================\n");

  const app = await createApp(true);
  const results: TestResult[] = [];

  const endpointsToTest = [
    // --- 1. Health & Meta (5 endpoints) ---
    {
      name: "Swagger UI",
      method: "GET",
      path: "/",
      expected: 200,
    },
    {
      name: "OpenAPI JSON Specification",
      method: "GET",
      path: "/json",
      expected: 200,
    },
    {
      name: "Vercel Platform Sanity Check",
      method: "GET",
      path: "/api/hello",
      expected: 200,
    },
    {
      name: "Liveness Check",
      method: "GET",
      path: "/v1/healthz",
      expected: 200,
    },
    {
      name: "Heartbeat Diagnostics",
      method: "GET",
      path: "/v1/heartbeat",
      expected: 200,
    },

    // --- 2. YouTube OAuth & API (9 endpoints) ---
    {
      name: "YouTube Auth Create (Missing Params -> 422)",
      method: "POST",
      path: "/v1/youtube/auth/create",
      body: {},
      expected: 422,
    },
    {
      name: "YouTube Auth Confirm (Missing Query -> 400)",
      method: "GET",
      path: "/v1/youtube/auth/confirm",
      expected: 400,
    },
    {
      name: "YouTube Channel Info (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/channel/info",
      body: { accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Video List (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/video/list",
      body: { handle: "@test", accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Comment List (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/comment/list",
      body: { videoId: "dummy-video", accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Comment Add (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/comment",
      body: { videoId: "dummy-video", commentText: "test comment", accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Comment Delete (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/comment/delete",
      body: { commentId: "dummy-comment", accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Reply List (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/reply/list",
      body: { parentId: "dummy-comment", accessToken: "invalid-token" },
      expected: 400,
    },
    {
      name: "YouTube Reply Add (Invalid Token -> 400)",
      method: "POST",
      path: "/v1/youtube/reply",
      body: { parentId: "dummy-comment", text: "test reply", accessToken: "invalid-token" },
      expected: 400,
    },

    // --- 3. Chat Widget & LLM (4 checks across 3 endpoints) ---
    {
      name: "Widget View Tenant & Rehydration",
      method: "POST",
      path: "/v2/widget/view",
      body: { widgetId: "default" },
      expected: 200,
    },
    {
      name: "Widget Create Thread (Invalid ID -> 403 Whitelist Guard)",
      method: "POST",
      path: "/v2/widget/create-thread",
      body: { widgetId: "invalid-unauthorized-id" },
      expected: 403,
    },
    {
      name: "Widget Ask (Invalid ID -> 403 Whitelist Guard)",
      method: "POST",
      path: "/v2/ask",
      body: { widgetId: "invalid-id", threadId: "any", message: "hi" },
      expected: 403,
    },
    {
      name: "Widget Ask (Token Bomb > 4000 chars -> 413 Payload Guard)",
      method: "POST",
      path: "/v2/ask",
      body: { widgetId: "default", threadId: "any", message: "a".repeat(4005) },
      expected: 413,
    },

    // --- 4. Admin Guard Verification (11 endpoints fail-closed 401) ---
    {
      name: "Admin Widgets List (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/widgets",
      body: {},
      expected: 401,
    },
    {
      name: "Admin Widgets Upsert (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/widgets/upsert",
      body: { id: "test-widget", name: "Test" },
      expected: 401,
    },
    {
      name: "Admin Widgets Delete (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/widgets/delete",
      body: { id: "test-widget" },
      expected: 401,
    },
    {
      name: "Admin Widgets Upload Icon (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/widgets/upload-icon",
      isMultipart: true,
      expected: 401,
    },
    {
      name: "Admin Threads List (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/threads",
      body: { widgetId: "default" },
      expected: 401,
    },
    {
      name: "Admin Threads Rename (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/threads/rename",
      body: { widgetId: "default", threadId: "any-thread-id", title: "New Title" },
      expected: 401,
    },
    {
      name: "Admin Threads Update (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/threads/update",
      body: { widgetId: "default", threadId: "any-thread-id", system_prompt: "Test" },
      expected: 401,
    },
    {
      name: "Admin Messages List (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/messages",
      body: { widgetId: "default", threadId: "any-thread-id" },
      expected: 401,
    },
    {
      name: "Admin DB Migrate (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/db/migrate",
      body: {},
      expected: 401,
    },
    {
      name: "Admin Mail Send (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/mail/send",
      body: { to: "test@example.com", subject: "hi", html: "world" },
      expected: 401,
    },
    {
      name: "Admin SMS Send (Missing Token -> 401)",
      method: "POST",
      path: "/v2/admin/sms/send",
      body: { to: "01000000000", text: "test" },
      expected: 401,
    },

    // --- 5. Dormant Routes Verification (Clean 404) ---
    {
      name: "Dormant Route: v1 Account Profile (Clean 404)",
      method: "GET",
      path: "/v1/account/get-user-profile",
      expected: 404,
    },
    {
      name: "Dormant Route: v1 Workspace List (Clean 404)",
      method: "POST",
      path: "/v1/workspace/list",
      body: {},
      expected: 404,
    },
    {
      name: "Dormant Route: v1 Billing Products (Clean 404)",
      method: "POST",
      path: "/v1/billing/product/list",
      body: {},
      expected: 404,
    },
    {
      name: "Dormant Route: v1 Botstore List (Clean 404)",
      method: "POST",
      path: "/v1/botstore/list",
      body: {},
      expected: 404,
    },
    {
      name: "Dormant Route: v1 Crawl Page Rank (Clean 404)",
      method: "POST",
      path: "/v1/crawl/page-rank",
      body: {},
      expected: 404,
    },
  ];

  function buildRequestInit(item: any): RequestInit {
    if (item.isMultipart) {
      const form = new FormData();
      form.append("widgetId", "default");
      const blob = new Blob(["fake png data"], { type: "image/png" });
      form.append("file", blob, "icon.png");
      return {
        method: item.method,
        body: form,
      };
    }

    const reqInit: RequestInit = {
      method: item.method,
    };
    if (item.body) {
      reqInit.headers = { "content-type": "application/json" };
      reqInit.body = JSON.stringify(item.body);
    }
    return reqInit;
  }

  console.log(`[Phase 1] Local In-Memory Sequential Test (${endpointsToTest.length} items)...`);
  for (const item of endpointsToTest) {
    const start = performance.now();
    const reqInit = buildRequestInit(item);
    const req = new Request(`http://localhost${item.path}`, reqInit);
    const res = await app.handle(req);
    const duration = performance.now() - start;

    const expectedArr = Array.isArray(item.expected) ? item.expected : [item.expected];
    const passed = expectedArr.includes(res.status);
    results.push({
      endpoint: `${item.method} ${item.path}`,
      method: item.method,
      target: "local",
      status: res.status,
      expectedStatus: item.expected,
      durationMs: Math.round(duration * 100) / 100,
      passed,
      notes: item.name,
    });
    console.log(`  ${passed ? "✅" : "❌"} [Local] ${item.method.padEnd(5)} ${item.path.padEnd(32)} -> ${res.status} (${duration.toFixed(2)}ms) - ${item.name}`);
  }

  console.log(`\n[Phase 2] Remote Production (Vercel) Sequential Test (${endpointsToTest.length} items)...`);
  for (const item of endpointsToTest) {
    const start = performance.now();
    const reqInit = buildRequestInit(item);

    try {
      const res = await fetch(`${REMOTE_BASE}${item.path}`, reqInit);
      const duration = performance.now() - start;
      const expectedArr = Array.isArray(item.expected) ? item.expected : [item.expected];
      const passed = expectedArr.includes(res.status);
      results.push({
        endpoint: `${item.method} ${item.path}`,
        method: item.method,
        target: "remote",
        status: res.status,
        expectedStatus: item.expected,
        durationMs: Math.round(duration * 100) / 100,
        passed,
        notes: item.name,
      });
      console.log(`  ${passed ? "✅" : "❌"} [Remote] ${item.method.padEnd(5)} ${item.path.padEnd(32)} -> ${res.status} (${duration.toFixed(2)}ms) - ${item.name}`);
    } catch (err: any) {
      results.push({
        endpoint: `${item.method} ${item.path}`,
        method: item.method,
        target: "remote",
        status: 0,
        expectedStatus: item.expected,
        durationMs: 0,
        passed: false,
        notes: `Network error: ${err.message}`,
      });
      console.log(`  ❌ [Remote] ${item.method.padEnd(5)} ${item.path.padEnd(32)} -> Error: ${err.message}`);
    }
  }

  const localPassed = results.filter((r) => r.target === "local" && r.passed).length;
  const remotePassed = results.filter((r) => r.target === "remote" && r.passed).length;
  console.log("\n==================================================================");
  console.log(`Local  Suite: ${localPassed} / ${endpointsToTest.length} PASS (${((localPassed / endpointsToTest.length) * 100).toFixed(1)}%)`);
  console.log(`Remote Suite: ${remotePassed} / ${endpointsToTest.length} PASS (${((remotePassed / endpointsToTest.length) * 100).toFixed(1)}%)`);
  console.log("==================================================================");

  if (localPassed !== endpointsToTest.length || remotePassed !== endpointsToTest.length) {
    console.error("Some checks failed!");
    process.exit(1);
  }
}

runLocalAndRemoteAudit().catch((err) => {
  console.error("Audit runner failed:", err);
  process.exit(1);
});
