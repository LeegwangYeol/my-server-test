/**
 * Milestone 3: Comprehensive E2E Adversarial Penetration Test Suite
 * Target: my-server-test/test/e2e-adversarial.test.ts
 *
 * Verifies:
 * 1. Automated attacks with 16 tampering vectors against /v2/ask and /v2/widget/create-thread (100% HTTP 403).
 * 2. Token bomb attacks: 4,001+ chars, Hangul, Astral Emojis, auxiliary fields > 2,000 chars, raw body > 1MB (100% HTTP 413).
 * 3. Multi-turn conversation history bounding (clamped to <= 10 messages and <= 16,000 characters).
 */

import { beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";

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

mock.module("../lib/chat-store", () => ({
  createThread: async (widgetId: string) => `thread-${widgetId}-${Date.now()}`,
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

let lastStreamRequest: any = null;
mock.module("../lib/llm", () => ({
  createLLMProvider: () => ({
    name: "mock-llm-e2e-adversarial",
    stream: async function* (req: any) {
      lastStreamRequest = req;
      yield "acknowledged";
    },
  }),
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

describe("Milestone 3: E2E Adversarial Penetration Suite", () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp(true);
  });

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEYS;
    mockMessages = [];
    lastStreamRequest = null;
  });

  // ─── 1. Whitelist Tampering Suite (16 Vectors -> HTTP 403) ────────
  describe("1. Whitelist Tampering Penetration (16 Vectors -> HTTP 403)", () => {
    const tamperingVectors: Array<{ name: string; body: Record<string, any> }> = [
      { name: "1. Missing widgetId property", body: { message: "Hello assistant" } },
      { name: "2. Explicit null widgetId", body: { widgetId: null, message: "Hello" } },
      { name: "3. Empty string widgetId", body: { widgetId: "", message: "Hello" } },
      { name: "4. Whitespace only (spaces, tabs, newlines)", body: { widgetId: "   \t\n\r  ", message: "Hello" } },
      { name: "5. SQLi classic tautology", body: { widgetId: "' OR '1'='1", message: "Hello" } },
      { name: "6. SQLi stacked DROP TABLE", body: { widgetId: "admin'; DROP TABLE widget; --", message: "Hello" } },
      { name: "7. SQLi UNION SELECT", body: { widgetId: "1' UNION SELECT * FROM widget --", message: "Hello" } },
      { name: "8. Path traversal Unix (/etc/passwd)", body: { widgetId: "../../../etc/passwd", message: "Hello" } },
      { name: "9. Path traversal Windows (win.ini)", body: { widgetId: "..\\..\\..\\windows\\win.ini", message: "Hello" } },
      { name: "10. Path traversal URL-encoded null byte", body: { widgetId: "..%2f..%2fsecrets%00", message: "Hello" } },
      { name: "11. Unregistered random UUID", body: { widgetId: "c82e89f0-c78c-48d4-b9ca-6f59949b3326", message: "Hello" } },
      { name: "12. Unicode homoglyph attack (Cyrillic e)", body: { widgetId: "r\u0435gistered-valid-widget", message: "Hello" } },
      { name: "13. Prototype pollution via object", body: JSON.parse('{"widgetId":{"__proto__":{"id":"admin"}},"message":"Hello"}') },
      { name: "14. Prototype pollution via root __proto__", body: JSON.parse('{"__proto__":{"isAdmin":true},"widgetId":"unregistered","message":"Hello"}') },
      { name: "15. Type confusion via array injection", body: { widgetId: ["registered-valid-widget"], message: "Hello" } },
      { name: "16. Type confusion via numeric injection", body: { widgetId: 1337, message: "Hello" } },
    ];

    describe("1.1 POST /v2/widget/create-thread Tampering", () => {
      for (const vector of tamperingVectors) {
        test(`vector [${vector.name}] returns HTTP 403`, async () => {
          const res = await postJson(app, "/v2/widget/create-thread", vector.body);
          expect(res.status).toBe(403);
          const data = (await res.json()) as any;
          expect(data.success).toBe(false);
          expect(data.error).toBeDefined();
        });
      }

      test("valid registered widgetId succeeds with HTTP 200", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", { widgetId: VALID_WIDGET_ID });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(typeof data.threadId).toBe("string");
      });
    });

    describe("1.2 POST /v2/ask Tampering", () => {
      for (const vector of tamperingVectors) {
        test(`vector [${vector.name}] returns HTTP 403`, async () => {
          const res = await postJson(app, "/v2/ask", vector.body);
          expect(res.status).toBe(403);
          const data = (await res.json()) as any;
          expect(data.success).toBe(false);
          expect(data.error).toBeDefined();
        });
      }

      test("valid registered widgetId passes whitelist guard (status != 403)", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Legitimate question",
        });
        expect(res.status).not.toBe(403);
      });
    });
  });

  // ─── 2. Token Bomb & Body Payload Attacks (HTTP 413) ──────────────
  describe("2. Token Bomb & Payload Guard Verification (HTTP 413)", () => {
    describe("2.1 Message Length Boundaries (/v2/ask)", () => {
      test("accepts boundary message of exactly 4,000 ASCII chars", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "A".repeat(4000),
        });
        expect(res.status).not.toBe(413);
      });

      test("rejects 4,001 ASCII characters with HTTP 413 and exact error", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "A".repeat(4001),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("message too long (4001 > 4000 chars)");
      });

      test("rejects massive 50,000 character token bomb with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "B".repeat(50000),
        });
        expect(res.status).toBe(413);
      });

      test("rejects multi-byte Hangul string of 4,002 code points with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "토끼".repeat(2001),
        });
        expect(res.status).toBe(413);
      });

      test("rejects astral emoji surrogate pairs exceeding 4,000 code units with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "🔥".repeat(2001),
        });
        expect(res.status).toBe(413);
      });
    });

    describe("2.2 Auxiliary Field Payload Smuggling (HTTP 413)", () => {
      test("rejects browserInfo string exceeding 2,000 chars with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid question",
          browserInfo: "X".repeat(2001),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.error).toContain("browserInfo too large");
      });

      test("rejects browserInfo JSON object exceeding 2,000 chars with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid question",
          browserInfo: { userAgent: "Mozilla", padding: "X".repeat(2000) },
        });
        expect(res.status).toBe(413);
      });

      test("rejects search options exceeding 2,000 chars with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid question",
          search: "Y".repeat(2001),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.error).toContain("search options too large");
      });

      test("accepts browserInfo and search within 2,000 character limit", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid question",
          browserInfo: { agent: "test" },
          search: { mode: "fast" },
        });
        expect(res.status).not.toBe(413);
      });
    });

    describe("2.3 Global HTTP Body Size Limit (1MB Ceiling)", () => {
      test("permits legitimate 800KB raw body", async () => {
        const payload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          extra: "Z".repeat(800 * 1024),
        });
        const res = await postJson(app, "/v2/ask", payload);
        expect(res.status).not.toBe(413);
      });

      test("rejects 1.2MB raw JSON payload with HTTP 413", async () => {
        const payload = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          extra: "Z".repeat(1200 * 1024),
        });
        const res = await postJson(app, "/v2/ask", payload);
        expect(res.status).toBe(413);
      });

      test("short-circuits request with Content-Length > 1MB with HTTP 413", async () => {
        const res = await postJson(
          app,
          "/v2/ask",
          JSON.stringify({ widgetId: VALID_WIDGET_ID, message: "Hello" }),
          { "content-length": "2097152" },
        );
        expect(res.status).toBe(413);
      });
    });

    describe("2.4 Multi-Turn Context Bounding Invariants", () => {
      test("bounds 50 prior turns (100,000 chars) to <= 10 messages and <= 16,000 chars", async () => {
        for (let i = 1; i <= 50; i++) {
          mockMessages.push({
            id: i,
            thread_id: "thread-50-turns",
            role: i % 2 === 1 ? "user" : "assistant",
            content: `Turn-${i}: ` + "Y".repeat(1990),
            created_at: new Date(Date.now() - (51 - i) * 1000).toISOString(),
          });
        }

        const userQuestion = "Latest question: " + "Q".repeat(480);
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          threadId: "thread-50-turns",
          message: userQuestion,
        });

        expect(res.status).not.toBe(500);
        expect(lastStreamRequest).not.toBeNull();

        const turns = lastStreamRequest.messages.filter((m: any) => m.role !== "system");
        expect(turns.length).toBeLessThanOrEqual(10);
        const totalChars = turns.reduce((acc: number, m: any) => acc + (m.content || "").length, 0);
        expect(totalChars).toBeLessThanOrEqual(16000);
        expect(turns[turns.length - 1].content).toBe(userQuestion);
      });
    });
  });
});
