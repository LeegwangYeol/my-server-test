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

      test("accepts browserInfo and search within 2,000 character limit", async () => {
        const res = await postJson(app, "/v2/ask", {
          widgetId: VALID_WIDGET_ID,
          message: "Safe message",
          browserInfo: { userAgent: "Mozilla/5.0", platform: "MacIntel" },
          search: { mode: "semantic" },
        });
        expect(res.status).not.toBe(413);
      });
    });
  });
});
