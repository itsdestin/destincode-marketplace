import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession, type TestAccount } from "./helpers";

async function seed(login = "testy"): Promise<{ token: string; account: TestAccount }> {
  const account = await createTestAccount({ login });
  const token = await issueTestSession(account);
  return { token, account };
}

async function seedInstall(userId: string, pluginId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
    .bind(userId, pluginId, now).run();
}

const TABLES = ["sessions", "identities", "users", "installs", "thumbs", "comments"];

function post(path: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`https://test.local${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /thumbs", () => {
  beforeEach(async () => {
    for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("401s without a token", async () => {
    const res = await post("/thumbs", null, { plugin_id: "foo:bar", value: "up" });
    expect(res.status).toBe(401);
  });

  it("403s when the user has not installed the plugin", async () => {
    const { token } = await seed();
    const res = await post("/thumbs", token, { plugin_id: "foo:bar", value: "up" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("must install plugin before voting");
  });

  it("records an up vote, flips it to down, then clears it — returning fresh totals each time", async () => {
    const { token, account } = await seed();
    await seedInstall(account.userId, "foo:bar");

    let res = await post("/thumbs", token, { plugin_id: "foo:bar", value: "up" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, vote: "up", thumbs_up: 1, thumbs_down: 0 });
    let row = await env.DB.prepare("SELECT vote FROM thumbs WHERE user_id = ? AND plugin_id = ?")
      .bind(account.userId, "foo:bar").first<{ vote: number }>();
    expect(row).toEqual({ vote: 1 });

    res = await post("/thumbs", token, { plugin_id: "foo:bar", value: "down" });
    expect(await res.json()).toEqual({ ok: true, vote: "down", thumbs_up: 0, thumbs_down: 1 });
    row = await env.DB.prepare("SELECT vote FROM thumbs WHERE user_id = ? AND plugin_id = ?")
      .bind(account.userId, "foo:bar").first<{ vote: number }>();
    expect(row).toEqual({ vote: -1 });

    res = await post("/thumbs", token, { plugin_id: "foo:bar", value: null });
    // SUM over an empty table is NULL — the route must normalize it to 0.
    expect(await res.json()).toEqual({ ok: true, vote: null, thumbs_up: 0, thumbs_down: 0 });
    row = await env.DB.prepare("SELECT vote FROM thumbs WHERE user_id = ? AND plugin_id = ?")
      .bind(account.userId, "foo:bar").first<{ vote: number }>();
    expect(row).toBeNull();
  });

  it("counts every voter's row in the totals, not just the caller's", async () => {
    const a = await seed("va");
    const b = await seed("vb");
    await seedInstall(a.account.userId, "foo:bar");
    await seedInstall(b.account.userId, "foo:bar");
    await post("/thumbs", a.token, { plugin_id: "foo:bar", value: "up" });
    const res = await post("/thumbs", b.token, { plugin_id: "foo:bar", value: "down" });
    expect(await res.json()).toEqual({ ok: true, vote: "down", thumbs_up: 1, thumbs_down: 1 });
  });

  it("400s on a bad value and on a bad plugin_id", async () => {
    const { token, account } = await seed();
    await seedInstall(account.userId, "foo:bar");
    let res = await post("/thumbs", token, { plugin_id: "foo:bar", value: "meh" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("value must be up, down or null");
    res = await post("/thumbs", token, { plugin_id: "", value: "up" });
    expect(res.status).toBe(400);
  });
});
