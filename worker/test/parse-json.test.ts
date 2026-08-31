import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

describe("malformed JSON bodies", () => {
  it("returns 400 (not 500) for a broken body on PATCH /auth/profile", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/auth/profile", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    // Pin the client-facing contract: HTTPException 400s carry the message as
    // a plain-text body (the desktop/Android clients read res.text()).
    expect(await res.text()).toBe("request body must be valid JSON");
  });

  it("returns 400 (not 500) for a broken body on PUT /auth/handle", async () => {
    // Both retrofitted endpoints are covered so a future refactor can't
    // silently drop the helper from just one of them.
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/auth/handle", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body must be valid JSON");
  });
  // The three routes that were still calling c.req.json() directly on 2026-08-31,
  // so a malformed body arrived as an unhandled SyntaxError and the client saw a
  // 500 ("we broke") instead of a 400 ("your request was broken").
  it("returns 400 (not 500) for a broken body on POST /ratings", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body must be valid JSON");
  });

  it("returns 400 (not 500) for a broken body on POST /reports", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/reports", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body must be valid JSON");
  });

  it("returns 400 (not 500) for a broken body on POST /auth/github/poll", async () => {
    // No auth on this one - it is the device-code poll a signed-out client makes.
    const res = await SELF.fetch("https://test.local/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body must be valid JSON");
  });
});
