import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../src/app";

describe("Payload Size Limit", () => {
  let app: any;
  beforeAll(async () => {
    app = await createApp(true);
  });

  test("multi-byte characters check bytes not length", async () => {
    // If we make a valid request to /v2/ask but the token limit doesn't hit us,
    // let's just make it huge.
    const bodyObj = {
      widgetId: "216ba20d-85fa-4c6c-a81d-e6b3ebde1e7e",
      message: "hello",
      padding: "가".repeat(500_000)
    };
    const payload = JSON.stringify(bodyObj);

    const req = new Request("http://localhost/v2/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });

    const res = await app.handle(req);
    expect(res.status).toBe(413);
  });
});
