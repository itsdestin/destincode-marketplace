import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

async function seed(): Promise<string> {
  return issueTestSession(await createTestAccount({ login: "testy" }));
}

describe("POST /themes/:id/like", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "theme_likes"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("adds a like on first call", async () => {
    const token = await seed();
    const res = await SELF.fetch("https://test.local/themes/strawberry-kitty/like", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ liked: true });
  });

  it("toggles off on second call", async () => {
    const token = await seed();
    for (let i = 0; i < 2; i++) {
      await SELF.fetch("https://test.local/themes/strawberry-kitty/like", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM theme_likes").all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });
});
