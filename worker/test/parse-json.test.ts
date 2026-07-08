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
  });
});
