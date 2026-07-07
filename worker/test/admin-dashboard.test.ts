import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

describe("GET /admin/dashboard", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("https://test.local/admin/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns HTML for an authenticated caller (admin gate is route-level, not page-level)", async () => {
    const acct = await createTestAccount({ githubId: "424242" });
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/admin/dashboard", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/YouCoded/);
    expect(body).toMatch(/chart\.umd\.min\.js/);
  });
});
