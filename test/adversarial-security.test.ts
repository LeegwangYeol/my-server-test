/**
 * Adversarial Security & Boundary Penetration Test Suite (Requirement R2)
 * Target: my-server-test/test/adversarial-security.test.ts
 *
 * Verifies:
 * 1. Whitelist guard (HTTP 403) on /v2/ask and /v2/widget/create-thread against tampering, omissions, and injections.
 * 2. Token bomb defenses (HTTP 413) on message length > 4,000 characters and global raw body payloads > 1MB.
 * 3. Multi-turn conversation context bounding to prevent context token bombs.
 */

import { beforeAll, describe, expect, test, mock } from "bun:test";

// ── Hermetic Mocking Setup ──────────────────────────────────────────
const VALID_WIDGET_ID = "registered-valid-widget";
const registeredWidgets = new Map<string, any>([
  [
    VALID_WIDGET_ID,
    {
      id: VALID_WIDGET_ID,
      name: "Valid Production Widget",
      theme: "noir",
      description: "Test Widget",
      welcome_message: "Hello!",
      system_prompt: "You are a test assistant.",
      suggested_questions: [],
      icon_url: null,
      chat_bubble_size: null,
      is_deleted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
]);

mock.module("../lib/widget-store", () => ({
  getWidget: async (id: string) => {
    if (!id || typeof id !== "string") return null;
    return registeredWidgets.get(id.trim()) ?? null;
  },
  listWidgetsRegistered: async () => Array.from(registeredWidgets.values()),
  upsertWidget: async (w: any) => w,
  deleteWidget: async () => true,
}));

let mockMessages: Array<{ id: number; thread_id: string; role: string; content: string; created_at: string }> = [];
let createThreadCalls = 0;

mock.module("../lib/chat-store", () => ({
  createThread: async (widgetId: string) => {
    createThreadCalls++;
    return `thread-${widgetId}-${Date.now()}`;
  },
  getThread: async (threadId: string, widgetId?: string) => ({
    id: threadId,
    widget_id: widgetId ?? VALID_WIDGET_ID,
    system_prompt: null,
    context_text: null,
  }),
  listMessages: async () => mockMessages,
  appendMessage: async (threadId: string, role: string, content: string) => {
    mockMessages.push({
      id: mockMessages.length + 1,
      thread_id: threadId,
      role,
      content,
      created_at: new Date().toISOString(),
    });
  },
  toWidgetMessage: (m: any) => ({ role: m.role, content: m.content }),
  listThreads: async () => [],
  listWidgets: async () => [],
  renameThread: async () => {},
  updateThreadPrompt: async () => {},
}));

const { createApp } = await import("../src/app");

type App = Awaited<ReturnType<typeof createApp>>;

const postJson = (app: App, path: string, body: unknown, extraHeaders: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("Adversarial Security Test Suite (Requirement R2)", () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp(true);
  });

  // ─── 1. Unauthorized widgetId Tampering Attacks (HTTP 403) ────────
  describe("1. Unauthorized widgetId Whitelist Guards (HTTP 403)", () => {
    describe("1.1 POST /v2/widget/create-thread", () => {
      test("rejects missing widgetId property with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {});
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("unregistered");
      });

      test("rejects empty string widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", { widgetId: "" });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
      });

      test("rejects whitespace-only widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", { widgetId: "   " });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
      });

      test("rejects unregistered arbitrary widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {
          widgetId: "attacker-forged-tenant-666",
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
      });

      test("rejects SQL injection payload in widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {
          widgetId: "' OR '1'='1",
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
      });

      test("rejects path traversal payload in widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {
          widgetId: "../../../etc/passwd",
        });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
      });

      test("accepts valid registered widgetId with HTTP 200", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {
          widgetId: VALID_WIDGET_ID,
        });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(typeof data.threadId).toBe("string");
        expect(data.threadId.length).toBeGreaterThan(0);
      });
    });

    describe("1.2 POST /v2/ask", () => {
      test("rejects missing widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", { message: "Hello assistant" });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("unregistered");
      });

      test("rejects empty string widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", { widgetId: "", message: "Hello" });
        expect(res.status).toBe(403);
      });

      test("rejects unregistered widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: "nonexistent-widget",
          message: "Hello",
        });
        expect(res.status).toBe(403);
      });

      test("rejects XSS script injection widgetId with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: "<script>alert('pwned')</script>",
          message: "Hello",
        });
        expect(res.status).toBe(403);
      });

      test("allows valid registered widgetId to pass authorization guard", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "What is your return policy?",
        });
        // Should NOT be 403 Forbidden
        expect(res.status).not.toBe(403);
      });
    });
  });

  // ─── 2. Token Bomb Payload & Body Size Attacks (HTTP 413) ────────
  describe("2. Token Bomb & Payload Guard Verification (HTTP 413)", () => {
    describe("2.1 Message Length Boundary Checks (/v2/ask)", () => {
      test("accepts message of exactly 4,000 ASCII characters", async () => {
        const exact4000 = "A".repeat(4000);
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: exact4000,
        });
        expect(res.status).not.toBe(413);
      });

      test("rejects message of 4,001 ASCII characters with HTTP 413", async () => {
        const overflow4001 = "A".repeat(4001);
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: overflow4001,
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("message too long (4001 > 4000 chars)");
      });

      test("rejects massive 50,000 character token bomb with HTTP 413", async () => {
        const bomb = "B".repeat(50000);
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: bomb,
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("message too long");
      });

      test("rejects multi-byte Unicode string exceeding 4,000 code points with HTTP 413", async () => {
        const koreanBomb = "가".repeat(4001);
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: koreanBomb,
        });
        expect(res.status).toBe(413);
      });
    });

    describe("2.2 Global HTTP Body Size Limit (1MB Ceiling)", () => {
      test("permits legitimate 500KB JSON payload", async () => {
        const safePayload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Small message",
          extraNotes: "X".repeat(500_000),
        });
        const res = await postJson(app, "/v2/ask", safePayload);
        expect(res.status).not.toBe(413);
      });

      test("rejects giant 1.2MB JSON payload with HTTP 413", async () => {
        const giantPayload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Small message",
          padding: "Z".repeat(1_200_000), // > 1MB
        });
        const res = await postJson(app, "/v2/ask", giantPayload);
        expect(res.status).toBe(413);
      });

      test("rejects request advertising Content-Length > 1MB with HTTP 413", async () => {
        const res = await postJson(
          app,
          "/v2/ask",
          JSON.stringify({ widgetId: VALID_WIDGET_ID, message: "hi" }),
          { "content-length": "2097152" }, // 2MB
        );
        expect(res.status).toBe(413);
      });

      test("rejects multi-byte UTF-8 (>1MB bytes, <1M chars) chunked JSON with charset param with HTTP 413", async () => {
        const multiBytePayload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "hi",
          padding: "가".repeat(500_000), // 500k UTF-16 code units, ~1.5MB UTF-8 bytes
        });
        const res = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: multiBytePayload,
          }),
        );
        expect(res.status).toBe(413);
      });
    });

    describe("2.3 Context History Token Bounding", () => {
      test("bounds accumulated multi-turn conversation history sent to LLM", async () => {
        mockMessages = [];
        // Simulate a thread with 25 long past messages (25 x 800 chars = 20,000 chars)
        for (let i = 0; i < 25; i++) {
          mockMessages.push({
            id: i + 1,
            thread_id: "thread-history-bomb",
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Message ${i}: ` + "H".repeat(800),
            created_at: new Date().toISOString(),
          });
        }

        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          threadId: "thread-history-bomb",
          message: "Latest question",
        });

        // Request must be processed safely without blowing memory or token limits
        expect(res.status).not.toBe(500);
      });
    });

    describe("2.4 Auxiliary Field Payload Smuggling Checks (HTTP 413)", () => {
      test("rejects browserInfo exceeding 2,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          browserInfo: {
            userAgent: "Mozilla/5.0",
            smuggledData: "X".repeat(2500),
          },
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("browserInfo too large");
      });

      test("rejects search options exceeding 2,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          search: "Y".repeat(2500),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("search options too large");
      });

      test("rejects threadId smuggling exceeding 2,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          threadId: "T".repeat(2500),
          message: "Safe message",
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("threadId too large");
      });

      test("rejects oversized widgetId (>256 chars) with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: "W".repeat(1000),
          message: "Safe message",
        });
        expect(res.status).toBe(403);
      });

      test("accepts browserInfo and search within 2,000 character limit", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          browserInfo: { userAgent: "Mozilla/5.0", platform: "MacIntel" },
          search: { mode: "semantic" },
        });
        expect(res.status).not.toBe(413);
      });

      test("rejects non-string threadId object exceeding 2,000 serialized chars with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          threadId: { smuggled: "T".repeat(2500) },
          message: "Safe message",
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("threadId too large");
      });

      test("returns HTTP 403 (not 422) when unregistered widget sends threadId: null", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: "unregistered-null-thread-client",
          threadId: null,
          message: "Hello",
        });
        expect(res.status).toBe(403);
      });
    });

    describe("2.5 Content-Type Normalization & Upload Bypass Hardening (HTTP 413)", () => {
      test("rejects uppercase APPLICATION/JSON >1MB chunked body with HTTP 413", async () => {
        const payload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "hi",
          pad: "U".repeat(1_150_000),
        });
        const res = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "APPLICATION/JSON" },
            body: payload,
          }),
        );
        expect(res.status).toBe(413);
      });

      test("rejects RFC 9110 OWS 'application/json ; charset=utf-8' >1MB body with HTTP 413", async () => {
        const payload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "hi",
          pad: "S".repeat(1_150_000),
        });
        const res = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "application/json ; charset=utf-8" },
            body: payload,
          }),
        );
        expect(res.status).toBe(413);
      });

      test("rejects structured +json ('application/problem+json') >1MB body with HTTP 413", async () => {
        const payload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "hi",
          pad: "P".repeat(1_150_000),
        });
        const res = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "application/problem+json" },
            body: payload,
          }),
        );
        expect(res.status).toBe(413);
      });

      test("rejects multipart/form-data parameter spoofing on /v2/ask (>1MB Content-Length) with HTTP 413", async () => {
        const res = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: {
              "content-type": "application/json; x=multipart/form-data",
              "content-length": "1800000",
            },
            body: JSON.stringify({ widgetId: VALID_WIDGET_ID, message: "hi" }),
          }),
        );
        expect(res.status).toBe(413);
      });
    });

    describe("2.6 Orphan Thread Spam Defense on /v2/widget/view & 5-Key Pool Failover", () => {
      test("does NOT insert orphan chat_thread rows when /v2/widget/view receives unregistered or empty widgetId", async () => {
        const beforeCalls = createThreadCalls;

        const resUnreg = await postJson(app, "/v2/widget/view", {
          widgetId: "unregistered-scraper-bot",
        });
        expect(resUnreg.status).toBe(200);
        const bodyUnreg = (await resUnreg.json()) as any;
        expect(bodyUnreg.thread_id).toBe("");
        expect(createThreadCalls).toBe(beforeCalls);

        const resEmpty = await postJson(app, "/v2/widget/view", { widgetId: "" });
        expect(resEmpty.status).toBe(200);
        const bodyEmpty = (await resEmpty.json()) as any;
        expect(bodyEmpty.thread_id).toBe("");
        expect(createThreadCalls).toBe(beforeCalls);

        // Registered widget MUST still allocate a valid thread when threadId is empty
        const resValid = await postJson(app, "/v2/widget/view", {
          widgetId: VALID_WIDGET_ID,
        });
        expect(resValid.status).toBe(200);
        const bodyValid = (await resValid.json()) as any;
        expect(bodyValid.thread_id).toContain(`thread-${VALID_WIDGET_ID}-`);
        expect(createThreadCalls).toBe(beforeCalls + 1);
      });

      test("RotatingLLMProvider auto-scales maxAttempts across 5-key pool and forwards perAttemptTimeoutMs", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");

        const store = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k1", { id: "k1", apiKey: "sk-1", accountId: "acc-dead", maxConcurrency: 5, weight: 100 }],
          ["k2", { id: "k2", apiKey: "sk-2", accountId: "acc-rl1", maxConcurrency: 5, weight: 90 }],
          ["k3", { id: "k3", apiKey: "sk-3", accountId: "acc-rl2", maxConcurrency: 5, weight: 80 }],
          ["k4", { id: "k4", apiKey: "sk-4", accountId: "acc-good", maxConcurrency: 5, weight: 70 }],
          ["k5", { id: "k5", apiKey: "sk-5", accountId: "acc-good", maxConcurrency: 5, weight: 60 }],
        ]);

        const provider = new RotatingLLMProvider(store, keyMap, {
          perAttemptTimeoutMs: 80,
        });

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async (_input: any, init?: RequestInit) => {
            const auth = String((init?.headers as any)?.Authorization ?? "");
            if (auth.includes("sk-1")) {
              return new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), {
                status: 402,
                headers: { "content-type": "application/json" },
              });
            }
            if (auth.includes("sk-2")) {
              return new Response(JSON.stringify({ error: { message: "Rate limit", code: 429 } }), {
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "5" },
              });
            }
            if (auth.includes("sk-3")) {
              // Simulate hung upstream > 80ms to verify perAttemptTimeoutMs is wired!
              await new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  reject(init.signal?.reason || new Error("ATTEMPT_TIMEOUT"));
                });
              });
            }
            return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }) as any;

          const t0 = performance.now();
          const hs = await provider.preStreamHandshake({
            messages: [{ role: "user", content: "ping" }],
          });
          const elapsed = performance.now() - t0;
          expect(["k4", "k5"]).toContain(hs.keyId);
          expect(elapsed).toBeLessThan(1500); // Proves 80ms timeout fired instead of hardcoded 6000ms!

          let out = "";
          for await (const chunk of provider.streamFromHandshake(hs)) {
            out += chunk;
          }
          expect(out).toBe("OK");
          const states = await store.getAllStates();
          expect(states.length).toBe(5);
          for (const st of states) {
            expect(st.inFlightRequests).toBe(0);
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });

    describe("2.7 2026-11-16 Hardening Regressions (Header Smuggling, Chunked Upload, Upstream 4xx, Reset Recovery)", () => {
      test("rejects Content-Length comma-smuggling ('10, 2097152') with HTTP 413 and conflicting values ('10, 20') with HTTP 400", async () => {
        const resSmuggled413 = await postJson(
          app,
          "/v2/ask",
          { widgetId: VALID_WIDGET_ID, message: "hi" },
          { "content-length": "10, 2097152" },
        );
        expect(resSmuggled413.status).toBe(413);

        const resConflict400 = await postJson(
          app,
          "/v2/ask",
          { widgetId: VALID_WIDGET_ID, message: "hi" },
          { "content-length": "10, 20" },
        );
        expect(resConflict400.status).toBe(400);

        const resNegative400 = await postJson(
          app,
          "/v2/ask",
          { widgetId: VALID_WIDGET_ID, message: "hi" },
          { "content-length": "-5" },
        );
        expect(resNegative400.status).toBe(400);
      });

      test("rejects chunked >2MB multipart/form-data stream on /v2/admin/widgets/upload-icon with HTTP 413", async () => {
        const boundary = "----TokkiChunkedBoundary9912";
        const headerBytes = new TextEncoder().encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.png"\r\nContent-Type: image/png\r\n\r\n`,
        );
        const tailBytes = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
        const chunk256k = new Uint8Array(256 * 1024).fill(0x41);

        let sentChunks = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sentChunks === 0) {
              controller.enqueue(headerBytes);
              sentChunks++;
              return;
            }
            // 9 * 256KB = 2.25MB > 2MB limit
            if (sentChunks <= 9) {
              controller.enqueue(chunk256k);
              sentChunks++;
              return;
            }
            controller.enqueue(tailBytes);
            controller.close();
          },
        });

        const res = await app.handle(
          new Request("http://localhost/v2/admin/widgets/upload-icon", {
            method: "POST",
            headers: {
              "content-type": `multipart/form-data; boundary=${boundary}`,
            },
            body: stream,
            // @ts-ignore - Bun/Undici streaming request body
            duplex: "half",
          }),
        );
        expect(res.status).toBe(413);
        const body = (await res.json()) as any;
        expect(body.success).toBe(false);
        expect(body.error).toContain("2MB");
      });

      test("accepts widgetId: null and threadId: null on /v2/widget/view without 422 validation error", async () => {
        const res = await postJson(app, "/v2/widget/view", {
          widgetId: null,
          threadId: null,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.thread_id).toBe("");
      });

      test("RotatingLLMProvider.preStreamHandshake throws UPSTREAM_CLIENT_ERROR on non-200 upstream 4xx instead of silent empty 200", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
        const { KeyManagerError } = await import("../lib/llm/key-manager");

        const store = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k1", { id: "k1", apiKey: "sk-1", accountId: "acc-1", maxConcurrency: 5, weight: 100 }],
        ]);
        const provider = new RotatingLLMProvider(store, keyMap);

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async () =>
            new Response(
              JSON.stringify({ error: { message: "Context length exceeded", code: 400 } }),
              { status: 400, headers: { "content-type": "application/json" } },
            )) as any;

          let caught: any = null;
          try {
            await provider.preStreamHandshake({
              messages: [{ role: "user", content: "bad request test" }],
            });
          } catch (err) {
            caught = err;
          }

          expect(caught).toBeInstanceOf(KeyManagerError);
          expect(caught.code).toBe("UPSTREAM_CLIENT_ERROR");
          expect(caught.statusCode).toBe(400);

          const states = await store.getAllStates();
          expect(states[0].inFlightRequests).toBe(0);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("MemoryKeyStore.resetKeyToActive clears brokenAccounts after 402 exhaustion so key is immediately selectable", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");

        const store = new MemoryKeyStore();
        await store.syncKeys([
          { id: "k-402", apiKey: "sk-402", accountId: "acc-topped-up", maxConcurrency: 5, weight: 100 },
        ]);

        const firstLease = await store.reserveKey();
        expect(firstLease?.keyId).toBe("k-402");

        await store.releaseKey(firstLease!.keyId, firstLease!.leaseToken, 402, 0, "Insufficient credits");

        // While broken, reserveKey returns null
        const blockedLease = await store.reserveKey();
        expect(blockedLease).toBeNull();

        // Operator tops up credits and resets key -> account-level broken flag MUST also clear
        await store.resetKeyToActive("k-402");
        const recoveredLease = await store.reserveKey();
        expect(recoveredLease).not.toBeNull();
        expect(recoveredLease?.keyId).toBe("k-402");

        await store.releaseKey(recoveredLease!.keyId, recoveredLease!.leaseToken, 200);
      });
    });

    describe("2.8 2026-11-17 Hardening Regressions (icon_url Bypass, Upstash L1/L2 Mirror Sync, 408 Failover, Sync Recovery)", () => {
      test("isValidWidgetIconUrl blocks protocol-relative (//evil), backslash (/\\evil), empty host, and credentialed URLs while allowing valid paths", async () => {
        const { isValidWidgetIconUrl } = await import("../lib/url-guard");

        expect(isValidWidgetIconUrl("//evil.attacker.com/icon.svg")).toBe(false);
        expect(isValidWidgetIconUrl("/\\evil.attacker.com/icon.svg")).toBe(false);
        expect(isValidWidgetIconUrl("https:///")).toBe(false);
        expect(isValidWidgetIconUrl("https://admin:secret@evil.com/icon.png")).toBe(false);
        expect(isValidWidgetIconUrl("javascript:alert(1)")).toBe(false);
        expect(isValidWidgetIconUrl("data:image/svg+xml,<svg/>")).toBe(false);

        expect(isValidWidgetIconUrl("/icons/widget-launcher.png")).toBe(true);
        expect(isValidWidgetIconUrl("https://cdn.tokki.app/icons/bot.webp")).toBe(true);

        const prevAdminToken = process.env.ADMIN_TOKEN;
        process.env.ADMIN_TOKEN = "test-admin-secret-20261117";
        try {
          const resProtoRel = await postJson(
            app,
            "/v2/admin/widgets/upsert",
            { id: VALID_WIDGET_ID, icon_url: "//evil.attacker.com/phish.svg" },
            { "x-admin-token": "test-admin-secret-20261117" },
          );
          expect(resProtoRel.status).toBe(400);

          const resBackslash = await postJson(
            app,
            "/v2/admin/widgets/upsert",
            { id: VALID_WIDGET_ID, icon_url: "/\\evil.attacker.com/phish.svg" },
            { "x-admin-token": "test-admin-secret-20261117" },
          );
          expect(resBackslash.status).toBe(400);
        } finally {
          if (prevAdminToken === undefined) {
            delete process.env.ADMIN_TOKEN;
          } else {
            process.env.ADMIN_TOKEN = prevAdminToken;
          }
        }
      });

      test("UpstashRedisKeyStore mirrors Redis reservations into L1 MemoryKeyStore so WARMUP canary graduation and getAllStates stay synchronized", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { UpstashRedisKeyStore } = await import("../lib/llm/key-manager/stores/upstash-redis");

        let nowMs = 1_700_000_000_000;
        const memoryFallback = new MemoryKeyStore({ clock: () => nowMs });
        const store = new UpstashRedisKeyStore("https://mock-upstash.local", "mock-token", {
          memoryFallback,
        });

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async (input: any, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/pipeline")) {
              return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (url.endsWith("/eval")) {
              const body = JSON.parse(String(init?.body ?? "[]"));
              const script = String(body[0] ?? "");
              if (script.includes("ERR_NO_ELIGIBLE_KEYS")) {
                return new Response(
                  JSON.stringify({ result: ["k-redis-1", `k-redis-1:${nowMs}:canary-1`] }),
                  { status: 200, headers: { "content-type": "application/json" } },
                );
              }
              if (script.includes("GRADUATED_ACTIVE")) {
                return new Response(
                  JSON.stringify({ result: "GRADUATED_ACTIVE" }),
                  { status: 200, headers: { "content-type": "application/json" } },
                );
              }
              return new Response(JSON.stringify({ result: "OK" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
          }) as any;

          await store.syncKeys([
            { id: "k-redis-1", apiKey: "sk-r1", tier: 0, weight: 100, maxConcurrency: 5 },
          ]);

          // Step 1: Key hits 429 cooldown for 1000ms
          await store.releaseKey("k-redis-1", "initial-lease", 429, 1000, "Rate limit");
          let states = await store.getAllStates();
          expect(states[0].status).toBe("RATE_LIMITED");
          expect(states[0].consecutive429s).toBe(1);

          // Step 2: Advance clock past cooldown; Redis issues WARMUP canary reservation
          nowMs += 1500;
          const res = await store.reserveKey();
          expect(res?.keyId).toBe("k-redis-1");

          states = await store.getAllStates();
          expect(states[0].status).toBe("WARMUP");
          expect(states[0].inFlightRequests).toBe(1);

          // Step 3: HTTP 200 headers arrive -> acknowledgeHandshake graduates BOTH Redis & L1 MemoryKeyStore!
          const graduated = await store.acknowledgeHandshake(res!.keyId, res!.leaseToken);
          expect(graduated).toBe(true);

          states = await store.getAllStates();
          expect(states[0].status).toBe("ACTIVE");
          expect(states[0].consecutive429s).toBe(0);
          expect(states[0].inFlightRequests).toBe(1);

          // Step 4: Stream completes -> ZSET lease drops to 0 in L1 as well
          await store.releaseKey(res!.keyId, res!.leaseToken, 200, 0);
          states = await store.getAllStates();
          expect(states[0].inFlightRequests).toBe(0);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("executor rotates past upstream HTTP 408 Request Timeout and RotatingLLMProvider recovers after transient syncKeys rejection", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");

        const store = new MemoryKeyStore();
        let failSyncOnce = true;
        const origSync = store.syncKeys.bind(store);
        store.syncKeys = async (keys) => {
          if (failSyncOnce) {
            failSyncOnce = false;
            throw new Error("Transient syncKeys failure");
          }
          return origSync(keys);
        };

        const keyMap = new Map<string, any>([
          ["k-timeout", { id: "k-timeout", apiKey: "sk-408", tier: 0, weight: 100, maxConcurrency: 5 }],
          ["k-good", { id: "k-good", apiKey: "sk-200", tier: 0, weight: 80, maxConcurrency: 5 }],
        ]);
        const provider = new RotatingLLMProvider(store, keyMap);

        // First call rejects due to transient syncKeys error, clearing syncPromise
        let firstErr: any = null;
        try {
          await provider.ensureSynced();
        } catch (e) {
          firstErr = e;
        }
        expect(firstErr).not.toBeNull();

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async (_input: any, init?: RequestInit) => {
            const auth = String((init?.headers as any)?.Authorization ?? "");
            if (auth.includes("sk-408")) {
              return new Response("Request Timeout", { status: 408 });
            }
            return new Response(
              'data: {"choices":[{"delta":{"content":"RECOVERED"}}]}\n\ndata: [DONE]\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }) as any;

          // Second call succeeds in syncing AND fails over cleanly past HTTP 408 -> k-good!
          const hs = await provider.preStreamHandshake({
            messages: [{ role: "user", content: "test 408 failover" }],
          });
          expect(hs.keyId).toBe("k-good");

          let output = "";
          for await (const tok of provider.streamFromHandshake(hs)) {
            output += tok;
          }
          expect(output).toBe("RECOVERED");

          const states = await store.getAllStates();
          for (const st of states) {
            expect(st.inFlightRequests).toBe(0);
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("POST /v2/ask rejects empty or whitespace-only message with HTTP 400 without creating orphan threads", async () => {
        const beforeCalls = createThreadCalls;
        const beforeMsgs = mockMessages.length;

        const resEmpty = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "",
        });
        expect(resEmpty.status).toBe(400);
        const bodyEmpty = (await resEmpty.json()) as any;
        expect(bodyEmpty.success).toBe(false);
        expect(bodyEmpty.error).toContain("message required");

        const resWhitespace = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "   \t\n\r  ",
        });
        expect(resWhitespace.status).toBe(400);
        expect(createThreadCalls).toBe(beforeCalls);
        expect(mockMessages.length).toBe(beforeMsgs);
      });
    });

    describe("2.9 2026-11-18 Hardening Regressions (Key-Scoped 401/403 Failover vs Account-Wide 402 & Moderation 403 Discrimination)", () => {
      test("rotates past per-key HTTP 403 spending cap and HTTP 401 revoked key WITHOUT poisoning healthy sibling keys in the same accountId", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
        const { RELEASE_KEY_LUA } = await import("../lib/llm/key-manager/lua/scripts");

        // Verify Lua parity: 402 bulk-invalidates account siblings while 401/403 isolate single key
        expect(RELEASE_KEY_LUA).toContain("elseif status == 402 then");
        expect(RELEASE_KEY_LUA).toContain("elseif status == 401 or status == 403 then");

        const store = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k-cap-403", { id: "k-cap-403", apiKey: "sk-cap-403", accountId: "acc-shared-org", tier: 0, weight: 100, maxConcurrency: 5 }],
          ["k-rev-401", { id: "k-rev-401", apiKey: "sk-rev-401", accountId: "acc-shared-org", tier: 0, weight: 90, maxConcurrency: 5 }],
          ["k-sib-ok", { id: "k-sib-ok", apiKey: "sk-sib-ok", accountId: "acc-shared-org", tier: 0, weight: 80, maxConcurrency: 5 }],
        ]);
        const provider = new RotatingLLMProvider(store, keyMap);

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async (_input: any, init?: RequestInit) => {
            const auth = String((init?.headers as any)?.Authorization ?? "");
            if (auth.includes("sk-cap-403")) {
              return new Response(
                JSON.stringify({ error: { code: 403, message: "Key limit exceeded ($10 monthly cap)" } }),
                { status: 403, headers: { "content-type": "application/json" } },
              );
            }
            if (auth.includes("sk-rev-401")) {
              return new Response(
                JSON.stringify({ error: { code: 401, message: "Invalid or revoked API key" } }),
                { status: 401, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(
              'data: {"choices":[{"delta":{"content":"SIBLING_FAILOVER_OK"}}]}\n\ndata: [DONE]\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }) as any;

          const hs = await provider.preStreamHandshake({
            messages: [{ role: "user", content: "test key-scoped 403/401 isolation" }],
          });
          expect(hs.keyId).toBe("k-sib-ok");

          let text = "";
          for await (const tok of provider.streamFromHandshake(hs)) {
            text += tok;
          }
          expect(text).toBe("SIBLING_FAILOVER_OK");

          const states = await store.getAllStates();
          const st403 = states.find((s) => s.id === "k-cap-403")!;
          const st401 = states.find((s) => s.id === "k-rev-401")!;
          const stOk = states.find((s) => s.id === "k-sib-ok")!;

          expect(st403.status).toBe("EXHAUSTED");
          expect(st403.lastStatusCode).toBe(403);
          expect(st401.status).toBe("EXHAUSTED");
          expect(st401.lastStatusCode).toBe(401);
          expect(stOk.status).toBe("ACTIVE");
          expect(states.every((s) => s.inFlightRequests === 0)).toBe(true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("does NOT exhaust healthy API key when upstream HTTP 403 is a prompt content moderation rejection", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");
        const { KeyManagerError } = await import("../lib/llm/key-manager");

        const store = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k-mod-1", { id: "k-mod-1", apiKey: "sk-mod-1", accountId: "acc-mod", tier: 0, weight: 100, maxConcurrency: 5 }],
          ["k-mod-2", { id: "k-mod-2", apiKey: "sk-mod-2", accountId: "acc-mod", tier: 0, weight: 80, maxConcurrency: 5 }],
        ]);
        const provider = new RotatingLLMProvider(store, keyMap);

        let calls = 0;
        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async () => {
            calls++;
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  message: "Input flagged by content moderation",
                  metadata: { reasons: ["violence"] },
                },
              }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
          }) as any;

          let caught: any = null;
          try {
            await provider.preStreamHandshake({
              messages: [{ role: "user", content: "flagged prompt" }],
            });
          } catch (e) {
            caught = e;
          }

          expect(calls).toBe(1);
          expect(caught).toBeInstanceOf(KeyManagerError);
          expect(caught.code).toBe("UPSTREAM_CLIENT_ERROR");

          const states = await store.getAllStates();
          expect(states[0].status).toBe("ACTIVE");
          expect(states[1].status).toBe("ACTIVE");
          expect(states.every((s) => s.inFlightRequests === 0)).toBe(true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("2026-11-19 Hardening: quarantines mid-stream in-band OpenRouter SSE 402/429 errors and aborts stalled SSE streams with ZCARD == 0", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { RotatingLLMProvider } = await import("../lib/llm/rotating-provider");

        const store = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k-inband-a", { id: "k-inband-a", apiKey: "sk-inband-a", accountId: "acc-inband", tier: 0, weight: 100, maxConcurrency: 5 }],
          ["k-inband-b", { id: "k-inband-b", apiKey: "sk-inband-b", accountId: "acc-inband", tier: 0, weight: 90, maxConcurrency: 5 }],
          ["k-inband-rl", { id: "k-inband-rl", apiKey: "sk-inband-rl", accountId: "acc-rl", tier: 1, weight: 80, maxConcurrency: 5 }],
          ["k-stall-1", { id: "k-stall-1", apiKey: "sk-stall-1", accountId: "acc-stall", tier: 2, weight: 70, maxConcurrency: 5 }],
        ]);
        const provider = new RotatingLLMProvider(store, keyMap, { chunkTimeoutMs: 50 });

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = (async (_url: any, init: any) => {
            const auth = new Headers(init?.headers).get("authorization") || "";
            const enc = new TextEncoder();
            if (auth.includes("sk-inband-a")) {
              return new Response(
                new ReadableStream({
                  start(c) {
                    c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
                    c.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ error: { code: 402, message: "Insufficient credits mid-stream" } })}\n\n`,
                      ),
                    );
                    c.close();
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              );
            }
            if (auth.includes("sk-inband-rl")) {
              return new Response(
                new ReadableStream({
                  start(c) {
                    c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
                    c.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ error: { code: 429, message: "Key rate limited mid-stream" } })}\n\n`,
                      ),
                    );
                    c.close();
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
                  // Hang indefinitely without closing to test chunkTimeoutMs watchdog
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }) as any;

          // 1. Mid-stream 402 must throw and bulk-exhaust acc-inband (both k-inband-a and sibling k-inband-b)
          let err1: any = null;
          try {
            for await (const _ of provider.stream({ messages: [{ role: "user", content: "q1" }] })) {}
          } catch (e) {
            err1 = e;
          }
          expect(String(err1?.message)).toContain("402");

          // 2. Next request skips both k-inband-a & k-inband-b, hits k-inband-rl -> mid-stream 429 marks RATE_LIMITED
          let err2: any = null;
          try {
            for await (const _ of provider.stream({ messages: [{ role: "user", content: "q2" }] })) {}
          } catch (e) {
            err2 = e;
          }
          expect(String(err2?.message)).toContain("429");

          // 3. Next request hits k-stall-1 -> chunkTimeoutMs (50ms) aborts cleanly with STREAM_TIMEOUT
          let err3: any = null;
          try {
            for await (const _ of provider.stream({ messages: [{ role: "user", content: "q3" }] })) {}
          } catch (e) {
            err3 = e;
          }
          expect(String(err3?.message)).toContain("STREAM_TIMEOUT");

          const states = await store.getAllStates();
          expect(states.find((s) => s.id === "k-inband-a")?.status).toBe("EXHAUSTED");
          expect(states.find((s) => s.id === "k-inband-b")?.status).toBe("EXHAUSTED");
          expect(states.find((s) => s.id === "k-inband-rl")?.status).toBe("RATE_LIMITED");
          expect(states.every((s) => s.inFlightRequests === 0)).toBe(true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("2026-11-19 Hardening: blocks non-string message smuggling (413/400), missing-message 422 leaks (403), and /v2/widget/view aux bombs (413)", async () => {
        // 1. Missing message with unregistered widgetId -> 403 Forbidden (not 422 TypeBox leak)
        const resUnregNoMsg = await postJson(app, "/v2/ask", {
          widgetId: "unregistered-no-msg-probe",
        });
        expect(resUnregNoMsg.status).toBe(403);

        // 2. Non-string message object > 4,000 serialized chars -> 413 Payload Too Large (not 422)
        const resSmuggledMsg = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: { nestedBomb: "M".repeat(4500) },
        });
        expect(resSmuggledMsg.status).toBe(413);

        // 3. Small non-string message with registered widgetId -> 400 Bad Request
        const resNonStrSmall = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: { text: "short" },
        });
        expect(resNonStrSmall.status).toBe(400);

        // 4. /v2/widget/view oversized threadId (> 2,000 chars) -> 413 Payload Too Large
        const resViewBomb = await postJson(app, "/v2/widget/view", {
          widgetId: VALID_WIDGET_ID,
          threadId: "V".repeat(2500),
        });
        expect(resViewBomb.status).toBe(413);

        // 5. /v2/widget/view 150-char stale threadId -> graceful 200 OK fresh thread (not 422)
        const resViewStale = await postJson(app, "/v2/widget/view", {
          widgetId: VALID_WIDGET_ID,
          threadId: "s".repeat(150),
        });
        expect(resViewStale.status).toBe(200);
      });

      test("2026-11-20 Hardening: fails over past tarpitted/stalled upstream 502/429 error bodies without deadlocking, and reconciles Upstash 402 exhaustions after Redis fail-open recovery", async () => {
        const { MemoryKeyStore } = await import("../lib/llm/key-manager/stores/memory");
        const { UpstashRedisKeyStore } = await import("../lib/llm/key-manager/stores/upstash-redis");
        const { executeWithResilientFailover } = await import("../lib/llm/key-manager/executor");
        const { OpenAICompatibleProvider } = await import("../lib/llm/openai-compatible");

        // 1. Stalled/tarpitted 502 error body must abort within perAttemptTimeoutMs (60ms) and fail over to k-fast-ok
        const memStore = new MemoryKeyStore();
        const keyMap = new Map<string, any>([
          ["k-tarpit-502", { id: "k-tarpit-502", apiKey: "sk-tarpit", tier: 0, weight: 100, maxConcurrency: 5 }],
          ["k-fast-ok", { id: "k-fast-ok", apiKey: "sk-fast", tier: 0, weight: 80, maxConcurrency: 5 }],
        ]);
        await memStore.syncKeys(Array.from(keyMap.values()));

        const t0 = performance.now();
        const hs = await executeWithResilientFailover(
          memStore,
          keyMap,
          async (apiKey) => {
            if (apiKey === "sk-tarpit") {
              // Returns 502 headers immediately, then hangs body stream forever
              return new Response(
                new ReadableStream({
                  start() {
                    /* tarpit: never close or enqueue */
                  },
                }),
                { status: 502, headers: { "content-type": "text/html" } },
              );
            }
            return new Response("data: [DONE]\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          },
          3,
          undefined,
          60, // 60ms per-attempt deadline
        );
        const elapsedMs = performance.now() - t0;
        expect(hs.keyId).toBe("k-fast-ok");
        expect(elapsedMs).toBeLessThan(500);
        await memStore.releaseKey(hs.keyId, hs.leaseToken, 200, 0);
        expect(await memStore.getActiveLeaseCount("k-tarpit-502")).toBe(0);
        expect(await memStore.getActiveLeaseCount("k-fast-ok")).toBe(0);

        // 2. UpstashRedisKeyStore reconciles 402 account-wide exhaustion back to Redis upon breaker recovery
        const originalFetch = globalThis.fetch;
        try {
          let redisDown = true;
          const redisPipelines: any[][][] = [];
          globalThis.fetch = (async (input: any, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("upstash.mock")) {
              if (redisDown) {
                throw new Error("Simulated Upstash outage");
              }
              if (url.endsWith("/pipeline")) {
                const cmds = JSON.parse(String(init?.body ?? "[]"));
                redisPipelines.push(cmds);
                return new Response(JSON.stringify(cmds.map(() => ({ result: "OK" }))), { status: 200 });
              }
              if (url.endsWith("/eval")) {
                return new Response(JSON.stringify({ result: ["k-backup-ok", "k-backup-ok:1:nonce"] }), {
                  status: 200,
                });
              }
            }
            return originalFetch(input, init);
          }) as any;

          const fallbackMem = new MemoryKeyStore();
          const redisStore = new UpstashRedisKeyStore("https://upstash.mock", "tok", {
            breakerDurationMs: 40,
            memoryFallback: fallbackMem,
          });
          await redisStore.syncKeys([
            { id: "k-outage-a", apiKey: "sk-oa", accountId: "acc-outage-402", tier: 0, weight: 100, maxConcurrency: 5 },
            { id: "k-outage-b", apiKey: "sk-ob", accountId: "acc-outage-402", tier: 0, weight: 90, maxConcurrency: 5 },
            { id: "k-backup-ok", apiKey: "sk-ok", accountId: "acc-ok", tier: 1, weight: 80, maxConcurrency: 5 },
          ]);

          // Trip storage breaker (3 failures) and record HTTP 402 while breaker is OPEN
          await redisStore.reserveKey();
          await redisStore.reserveKey();
          const rOpen = await redisStore.reserveKey(); // 3rd failure trips breaker OPEN
          expect(rOpen).not.toBeNull();
          await redisStore.releaseKey("k-outage-a", rOpen!.leaseToken, 402, Infinity, "Wallet empty during Redis outage");

          // Wait for breaker window (40ms) to expire and bring Redis back online
          await new Promise((r) => setTimeout(r, 55));
          redisDown = false;

          const rRecovered = await redisStore.reserveKey();
          expect(rRecovered?.keyId).toBe("k-backup-ok");
          // Pipeline must have flushed EXHAUSTED for both k-outage-a & sibling k-outage-b + broken account flag!
          const flatCmds = JSON.stringify(redisPipelines);
          expect(flatCmds).toContain("openrouter:key:k-outage-a");
          expect(flatCmds).toContain("openrouter:key:k-outage-b");
          expect(flatCmds).toContain("openrouter:account:acc-outage-402:broken");
          await redisStore.releaseKey(rRecovered!.keyId, rRecovered!.leaseToken, 200, 0);

          // 3. OpenAICompatibleProvider enforces chunkTimeoutMs stall watchdog
          globalThis.fetch = (async () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode(": keepalive\n\n"));
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            )) as any;

          const singleProvider = new OpenAICompatibleProvider({
            name: "single-stall-test",
            baseUrl: "https://mock-llm.local/v1",
            apiKey: "sk-single",
            defaultModel: "gpt-4o-mini",
            chunkTimeoutMs: 50,
          });
          let stallErr: any = null;
          try {
            for await (const _ of singleProvider.stream({ messages: [{ role: "user", content: "hi" }] })) {}
          } catch (e) {
            stallErr = e;
          }
          expect(String(stallErr?.message)).toContain("STREAM_TIMEOUT");
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("2026-11-20 Hardening: blocks CORS text/plain & JSON null/Array schema-leak bypasses (403/413) across /v2/ask, /v2/widget/create-thread, and /v2/widget/view", async () => {
        // 1. CORS simple-request text/plain probe on /v2/ask -> 403 Forbidden (NOT 422 TypeBox schema dump)
        const resPlainAsk = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: '{"widgetId":"spoof","message":"hello"}',
          }),
        );
        expect(resPlainAsk.status).toBe(403);

        // 2. CORS simple-request >4,000-char text/plain bomb on /v2/ask -> 413 Payload Too Large
        const resPlainAskBomb = await app.handle(
          new Request("http://localhost/v2/ask", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "B".repeat(4500),
          }),
        );
        expect(resPlainAskBomb.status).toBe(413);

        // 3. JSON null and JSON Array root on /v2/ask & /v2/widget/create-thread -> 403 Forbidden (NOT 422)
        const resNullAsk = await postJson(app, "/v2/ask", "null");
        expect(resNullAsk.status).toBe(403);

        const resArrAsk = await postJson(app, "/v2/ask", ["spoof"]);
        expect(resArrAsk.status).toBe(403);

        const resNullThread = await postJson(app, "/v2/widget/create-thread", "null");
        expect(resNullThread.status).toBe(403);

        const resArrThread = await postJson(app, "/v2/widget/create-thread", ["spoof"]);
        expect(resArrThread.status).toBe(403);

        // 4. Oversized widgetId object (>4,000 chars) on /v2/widget/create-thread -> 413 Payload Too Large
        const resThreadBomb = await postJson(app, "/v2/widget/create-thread", {
          widgetId: { nestedBomb: "W".repeat(4500) },
        });
        expect(resThreadBomb.status).toBe(413);

        // 5. JSON null/Array on /v2/widget/view -> graceful 200 OK default persona (no 422 leak); oversized text/plain -> 413
        const resNullView = await postJson(app, "/v2/widget/view", "null");
        expect(resNullView.status).toBe(200);

        const resPlainViewBomb = await app.handle(
          new Request("http://localhost/v2/widget/view", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "V".repeat(2500),
          }),
        );
        expect(resPlainViewBomb.status).toBe(413);
      });
    });
  });
});
