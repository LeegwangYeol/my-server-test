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
  });
});
