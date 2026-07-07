import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession, type TestAccount } from "./helpers";

// Seed an account + a real session; return { token, account } so tests can
// assert on the opaque account id (no more parseable github: ids).
async function seedUserAndToken(): Promise<{ token: string; account: TestAccount }> {
  const account = await createTestAccount({ login: "testy" });
  const token = await issueTestSession(account);
  return { token, account };
}

describe("POST /installs", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("401s without a token", async () => {
    const res = await SELF.fetch("https://test.local/installs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_id: "commit-commands:commit" }),
    });
    expect(res.status).toBe(401);
  });

  it("records an install for an authenticated user", async () => {
    const { token, account } = await seedUserAndToken();
    const res = await SELF.fetch("https://test.local/installs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plugin_id: "commit-commands:commit" }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT user_id, plugin_id FROM installs WHERE plugin_id = ?")
      .bind("commit-commands:commit").first();
    expect(row).toEqual(expect.objectContaining({ user_id: account.userId }));
  });

  it("is idempotent (re-installing the same plugin does not error)", async () => {
    const { token } = await seedUserAndToken();
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch("https://test.local/installs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plugin_id: "commit-commands:commit" }),
      });
      expect(res.status).toBe(200);
    }
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });
});
