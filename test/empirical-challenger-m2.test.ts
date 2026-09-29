/**
 * Empirical Challenger M2: Backend Whitelist & Payload Security Penetration Suite
 * Target: my-server-test/test/empirical-challenger-m2.test.ts
 *
 * Empirical verification of:
 * 1. Unauthorized widgetId tampering (missing, empty, whitespace, arbitrary, SQLi, path traversal, XSS) -> HTTP 403
 * 2. Token bomb payloads (> 4000 chars, Unicode code points, auxiliary smuggling) & raw JSON body (> 1MB) -> HTTP 413
 * 3. Conversation history bounding: 50 prior turns clamped to <= 10 messages and <= 16,000 characters
 */

import { beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";

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
    return registeredWidgets.get(id) ?? null;
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
    name: "mock-llm-challenger",
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

describe("Milestone 2 Empirical Challenger Penetration Suite", () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp(true);
  });

  beforeEach(() => {
    mockMessages = [];
    lastStreamRequest = null;
  });

  // ════════════════════════════════════════════════════════════════════
  // 1. Unauthorized widgetId Tampering Attacks
  // ════════════════════════════════════════════════════════════════════
  describe("1. Unauthorized widgetId Tampering Tests", () => {
    const maliciousWidgetIds = [
      { label: "empty string", value: "" },
      { label: "single space", value: " " },
      { label: "multiple spaces", value: "    " },
      { label: "tab and newline", value: "\t\n\r" },
      { label: "arbitrary nonexistent id", value: "forged-tenant-999" },
      { label: "SQLi classic OR", value: "' OR '1'='1" },
      { label: "SQLi DROP TABLE", value: "'; DROP TABLE widget; --" },
      { label: "SQLi UNION SELECT", value: "1' UNION SELECT * FROM widget --" },
      { label: "Path traversal /etc/passwd", value: "../../../etc/passwd" },
      { label: "Path traversal Windows win.ini", value: "..\\..\\..\\windows\\win.ini" },
      { label: "Path traversal double encoded", value: "....//....//....//etc/passwd" },
      { label: "XSS script injection", value: "<script>alert('pwned')</script>" },
    ];

    describe("1.1 POST /v2/widget/create-thread Tampering", () => {
      test("rejects missing widgetId field with HTTP 403", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", {});
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("unregistered");
      });

      for (const { label, value } of maliciousWidgetIds) {
        test(`rejects ${label} with HTTP 403`, async () => {
          const res = await postJson(app, "/v2/widget/create-thread", { widgetId: value });
          expect(res.status).toBe(403);
          const data = (await res.json()) as any;
          expect(data.success).toBe(false);
        });
      }

      test("accepts valid registered widgetId with HTTP 200", async () => {
        const res = await postJson(app, "/v2/widget/create-thread", { widgetId: VALID_WIDGET_ID });
        expect(res.status).toBe(200);
        const data = (await res.json()) as any;
        expect(data.success).toBe(true);
        expect(typeof data.threadId).toBe("string");
      });
    });

    describe("1.2 POST /v2/ask Tampering", () => {
      test("rejects missing widgetId field with HTTP 403", async () => {
        const res = await postJson(app, "/v2/ask", { message: "Hello world" });
        expect(res.status).toBe(403);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("unregistered");
      });

      for (const { label, value } of maliciousWidgetIds) {
        test(`rejects ${label} with HTTP 403`, async () => {
          const res = await postJson(app, "/v2/ask", { widgetId: value, message: "Hello world" });
          expect(res.status).toBe(403);
          const data = (await res.json()) as any;
          expect(data.success).toBe(false);
        });
      }

      test("allows valid registered widgetId through authorization guard", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Legitimate question",
        });
        expect(res.status).not.toBe(403);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 2. Token Bomb Payloads & Body Size Attacks (HTTP 413)
  // ════════════════════════════════════════════════════════════════════
  describe("2. Token Bomb Payloads & Body Size Limits (HTTP 413)", () => {
    describe("2.1 Message Length Boundary at /v2/ask", () => {
      test("accepts exactly 4,000 characters without 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "M".repeat(4000),
        });
        expect(res.status).not.toBe(413);
      });

      test("rejects 4,001 characters with HTTP 413 and exact error", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "M".repeat(4001),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.success).toBe(false);
        expect(data.error).toContain("message too long (4001 > 4000 chars)");
      });

      test("rejects 10,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "X".repeat(10000),
        });
        expect(res.status).toBe(413);
      });

      test("rejects multi-byte Korean string > 4,000 code points with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "토끼".repeat(2001), // 4002 code points
        });
        expect(res.status).toBe(413);
      });

      test("accepts multi-byte Korean string <= 4,000 code points", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "토끼".repeat(2000), // 4000 code points
        });
        expect(res.status).not.toBe(413);
      });

      test("rejects emoji surrogate pairs exceeding 4,000 UTF-16 code units with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "🔥".repeat(2001), // 4002 length in JS
        });
        expect(res.status).toBe(413);
      });
    });

    describe("2.2 Auxiliary Payload Smuggling (browserInfo & search)", () => {
      test("rejects browserInfo exceeding 2,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid message",
          browserInfo: { payload: "B".repeat(2001) },
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.error).toContain("browserInfo too large");
      });

      test("rejects search options exceeding 2,000 characters with HTTP 413", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Valid message",
          search: "S".repeat(2001),
        });
        expect(res.status).toBe(413);
        const data = (await res.json()) as any;
        expect(data.error).toContain("search options too large");
      });
    });

    describe("2.3 Global Body Size Limit (1MB Ceiling)", () => {
      test("accepts 800KB raw body below 1MB ceiling", async () => {
        const body = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Hello",
          padding: "P".repeat(800 * 1024),
        });
        const res = await postJson(app, "/v2/ask", body);
        expect(res.status).not.toBe(413);
      });

      test("rejects 1.1MB raw body with HTTP 413", async () => {
        const body = JSON.stringify({
          widgetId: VALID_WIDGET_ID,
          message: "Hello",
          padding: "P".repeat(1100 * 1024),
        });
        const res = await postJson(app, "/v2/ask", body);
        expect(res.status).toBe(413);
      });

      test("rejects request advertising Content-Length > 1MB with HTTP 413", async () => {
        const res = await postJson(
          app,
          "/v2/ask",
          JSON.stringify({ widgetId: VALID_WIDGET_ID, message: "Hello" }),
          { "content-length": "1048577" },
        );
        expect(res.status).toBe(413);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 3. Conversation History Bounding Verification
  // ════════════════════════════════════════════════════════════════════
  describe("3. Conversation History Bounding Invariants", () => {
    test("Scenario A: 50 short prior turns are clamped to <= 10 messages and <= 16,000 characters", async () => {
      mockMessages = [];
      // Populate 50 prior turns of 100 characters each (50 * 100 = 5,000 chars)
      for (let i = 1; i <= 50; i++) {
        mockMessages.push({
          id: i,
          thread_id: "thread-50-short",
          role: i % 2 === 1 ? "user" : "assistant",
          content: `Msg-${i.toString().padStart(2, "0")}: ` + "x".repeat(90), // exactly 98 chars
          created_at: new Date(Date.now() - (51 - i) * 1000).toISOString(),
        });
      }

      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        threadId: "thread-50-short",
        message: "Question 51",
      });

      expect(res.status).not.toBe(500);
      expect(lastStreamRequest).not.toBeNull();

      // Extract conversation turns passed to LLM provider (excluding system prompts)
      const chatTurns = lastStreamRequest.messages.filter((m: any) => m.role !== "system");

      // Invariant 1: Message count <= 10
      expect(chatTurns.length).toBeLessThanOrEqual(10);
      expect(chatTurns.length).toBe(10); // Exactly the last 10 messages (including new user question)

      // Invariant 2: Total characters <= 16,000
      const totalChars = chatTurns.reduce((sum: number, m: any) => sum + (m.content || "").length, 0);
      expect(totalChars).toBeLessThanOrEqual(16000);

      // Invariant 3: The latest user message is preserved at the end
      expect(chatTurns[chatTurns.length - 1].content).toBe("Question 51");
    });

    test("Scenario B: 50 long prior turns (2,000 chars each = 100,000 chars) are clamped to <= 10 messages and <= 16,000 chars", async () => {
      mockMessages = [];
      // Populate 50 prior turns of 2,000 characters each (total 100,000 characters)
      for (let i = 1; i <= 50; i++) {
        mockMessages.push({
          id: i,
          thread_id: "thread-50-long",
          role: i % 2 === 1 ? "user" : "assistant",
          content: `Turn-${i}: ` + "Y".repeat(1990),
          created_at: new Date(Date.now() - (51 - i) * 1000).toISOString(),
        });
      }

      const userQuestion = "Question 51 with 500 characters: " + "Q".repeat(467);
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        threadId: "thread-50-long",
        message: userQuestion,
      });

      expect(res.status).not.toBe(500);
      expect(lastStreamRequest).not.toBeNull();

      const chatTurns = lastStreamRequest.messages.filter((m: any) => m.role !== "system");

      // Invariant 1: Clamped to at most 10 messages
      expect(chatTurns.length).toBeLessThanOrEqual(10);

      // Invariant 2: Total characters MUST NOT exceed 16,000 characters
      const totalChars = chatTurns.reduce((sum: number, m: any) => sum + (m.content || "").length, 0);
      expect(totalChars).toBeLessThanOrEqual(16000);

      // Mathematical proof of clamp:
      // Latest turn = 500 chars
      // Prior turns: each message from i=44..50 has length 9 + 1990 = 1999 chars
      // 500 + 7 * 1999 = 14,493 <= 16,000. 14,493 + 1999 = 16,492 > 16,000.
      // Therefore, bounded history contains exactly 8 messages (1 user question + 7 prior turns)
      expect(chatTurns.length).toBe(8);
      expect(totalChars).toBe(14493);

      // Invariant 3: The latest user message is preserved at the end
      expect(chatTurns[chatTurns.length - 1].content).toBe(userQuestion);
    });

    test("Scenario C: 50 prior turns of 3,500 characters each (175,000 chars) are clamped to <= 10 messages and <= 16,000 chars", async () => {
      mockMessages = [];
      for (let i = 1; i <= 50; i++) {
        mockMessages.push({
          id: i,
          thread_id: "thread-50-giant",
          role: i % 2 === 1 ? "user" : "assistant",
          content: `GiantTurn-${i}: ` + "Z".repeat(3485), // 3,499 chars for i>=10
          created_at: new Date(Date.now() - (51 - i) * 1000).toISOString(),
        });
      }

      const userQuestion = "Latest question: " + "W".repeat(983); // 1,000 chars
      const res = await postJson(app, "/v2/ask", {
        widgetId: VALID_WIDGET_ID,
        threadId: "thread-50-giant",
        message: userQuestion,
      });

      expect(res.status).not.toBe(500);
      expect(lastStreamRequest).not.toBeNull();

      const chatTurns = lastStreamRequest.messages.filter((m: any) => m.role !== "system");

      // Invariant 1: Clamped to <= 10 messages
      expect(chatTurns.length).toBeLessThanOrEqual(10);

      // Invariant 2: Total characters <= 16,000 chars
      const totalChars = chatTurns.reduce((sum: number, m: any) => sum + (m.content || "").length, 0);
      expect(totalChars).toBeLessThanOrEqual(16000);

      // 1,000 + 4 * 3,499 = 14,996 <= 16000; 14,996 + 3,499 = 18,495 > 16,000
      // Therefore, exactly 5 messages should be included (1 user question + 4 prior turns)
      expect(chatTurns.length).toBe(5);
      expect(totalChars).toBe(14996);

      // Invariant 3: Latest question is preserved
      expect(chatTurns[chatTurns.length - 1].content).toBe(userQuestion);
    });
  });
});
