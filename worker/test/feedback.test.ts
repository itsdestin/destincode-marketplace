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

describe("POST /comments + GET /comments/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("401s without a token", async () => {
    const res = await post("/comments", null, { plugin_id: "foo:bar", text: "hi" });
    expect(res.status).toBe(401);
  });

  it("does NOT require an install (questions before installing are the point)", async () => {
    const { token } = await seed();
    const res = await post("/comments", token, { plugin_id: "foo:bar", text: "Does this work offline?" });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; id: string; hidden: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.hidden).toBe(false);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("400s on empty text, link spam and overlong text", async () => {
    const { token } = await seed();
    expect((await post("/comments", token, { plugin_id: "foo:bar", text: "   " })).status).toBe(400);
    const r = await post("/comments", token, { plugin_id: "foo:bar", text: "a https://a.x b https://b.x c https://c.x" });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("too many links (at most 2)");
    expect((await post("/comments", token, { plugin_id: "foo:bar", text: "z".repeat(2001) })).status).toBe(400);
  });

  // NOTE: there is deliberately no "classifier flags it" route test. `[env.test]`
  // omits the AI binding and it cannot be stubbed (test/setup.ts explains, with
  // the probe result) — `classifyReview` always fail-opens here, so the route's
  // hidden=1 branch is unreachable under vitest. The verdict logic is covered
  // directly in `moderation.test.ts`; the reader-facing half — a hidden
  // row is never listed — is covered by the next test.

  it("lists visible comments newest first with the author's login and avatar", async () => {
    const { token, account } = await seed("alice");
    await post("/comments", token, { plugin_id: "foo:bar", text: "first" });
    // Force an earlier created_at on the first row so ordering is deterministic.
    await env.DB.prepare("UPDATE comments SET created_at = created_at - 100").run();
    await post("/comments", token, { plugin_id: "foo:bar", text: "second" });
    // A hidden row must never be listed.
    await env.DB.prepare(
      "INSERT INTO comments (id, user_id, plugin_id, text, created_at, hidden) VALUES ('h1', ?, 'foo:bar', 'nope', 9999999999, 1)"
    ).bind(account.userId).run();

    const res = await SELF.fetch("https://test.local/comments/foo%3Abar");
    expect(res.status).toBe(200);
    const { comments } = await res.json<{ comments: Array<{ id: string; user_id: string; user_login: string; user_avatar_url: string | null; text: string; created_at: number }> }>();
    expect(comments.map((c) => c.text)).toEqual(["second", "first"]);
    expect(comments[0]!.user_id).toBe(account.userId);
    expect(comments[0]!.user_login).toBe("alice");
    expect(typeof comments[0]!.created_at).toBe("number");
  });

  it("returns an empty list for an unknown plugin", async () => {
    const res = await SELF.fetch("https://test.local/comments/nothing-here");
    expect(await res.json()).toEqual({ comments: [] });
  });

  it("reads a bundle MEMBER's thread — the id has a slash", async () => {
    const { token } = await seed("bob");
    const memberId = "superpowers/brainstorming";
    expect((await post("/comments", token, { plugin_id: memberId, text: "does this need a key?" })).status).toBe(200);
    // Unencoded: this is how the renderer builds the URL for a member page.
    const res = await SELF.fetch("https://test.local/comments/superpowers/brainstorming");
    expect(res.status).toBe(200);
    const { comments } = await res.json<{ comments: Array<{ text: string }> }>();
    expect(comments.map((c) => c.text)).toEqual(["does this need a key?"]);
  });
});

describe("GET /thumbs/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("401s without a token", async () => {
    expect((await SELF.fetch("https://test.local/thumbs/foo:bar")).status).toBe(401);
  });

  it("returns null before voting, then the vote, for plugin and member ids", async () => {
    const { token, account } = await seed();
    const get = (id: string) => SELF.fetch(`https://test.local/thumbs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await (await get("foo:bar")).json()).toEqual({ vote: null });
    await seedInstall(account.userId, "foo:bar");
    await post("/thumbs", token, { plugin_id: "foo:bar", value: "down" });
    expect(await (await get("foo:bar")).json()).toEqual({ vote: "down" });

    await seedInstall(account.userId, "superpowers/brainstorming");
    await post("/thumbs", token, { plugin_id: "superpowers/brainstorming", value: "up" });
    expect(await (await get("superpowers/brainstorming")).json()).toEqual({ vote: "up" });
  });

  it("is per-caller: another signed-in user sees their own vote, not yours", async () => {
    const a = await seed("ta");
    const b = await seed("tb");
    await seedInstall(a.account.userId, "foo:bar");
    await post("/thumbs", a.token, { plugin_id: "foo:bar", value: "up" });
    const res = await SELF.fetch("https://test.local/thumbs/foo:bar", { headers: { Authorization: `Bearer ${b.token}` } });
    expect(await res.json()).toEqual({ vote: null });
  });
});

describe("admin comment takedown", () => {
  beforeEach(async () => {
    for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  // 424242 is the admin github id in wrangler.toml [env.test.vars] ADMIN_USER_IDS.
  const asAdmin = async () => ({
    Authorization: `Bearer ${await issueTestSession(await createTestAccount({ githubId: "424242", login: "admin" }))}`,
  });

  it("an admin can hide a comment, and a non-admin cannot", async () => {
    const { token: authorToken } = await seed("u");
    await post("/comments", authorToken, { plugin_id: "foo", text: "something awful" });
    const { comments } = await (await SELF.fetch("https://test.local/comments/foo")).json<{ comments: Array<{ id: string }> }>();
    const id = comments[0]!.id;

    // A signed-in non-admin is refused 403, not 401 — they ARE authenticated.
    expect((await SELF.fetch(`https://test.local/admin/comments/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${authorToken}` },
    })).status).toBe(403);

    const admin = await asAdmin();
    expect((await SELF.fetch(`https://test.local/admin/comments/${id}`, { method: "DELETE", headers: admin })).status).toBe(200);

    // Gone from the public read, still in the table, and visible in the admin queue.
    expect((await (await SELF.fetch("https://test.local/comments/foo")).json<{ comments: unknown[] }>()).comments).toEqual([]);
    const row = await env.DB.prepare("SELECT hidden FROM comments WHERE id = ?").bind(id).first<{ hidden: number }>();
    expect(row).toEqual({ hidden: 1 });
    const q = await (await SELF.fetch("https://test.local/admin/comments?hidden=1", { headers: admin })).json<{ comments: Array<{ id: string }> }>();
    expect(q.comments.map((c) => c.id)).toEqual([id]);
  });

  it("hiding an id that is not there reports it, rather than claiming success", async () => {
    expect((await SELF.fetch("https://test.local/admin/comments/nope", {
      method: "DELETE", headers: await asAdmin(),
    })).status).toBe(404);
  });

  it("the queue defaults to visible comments and is refused to a non-admin", async () => {
    const { token } = await seed("plain");
    await post("/comments", token, { plugin_id: "foo", text: "hello there" });
    expect((await SELF.fetch("https://test.local/admin/comments", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    const q = await (await SELF.fetch("https://test.local/admin/comments", { headers: await asAdmin() })).json<{ comments: Array<{ text: string; hidden: number }> }>();
    expect(q.comments.map((c) => c.text)).toEqual(["hello there"]);
    expect(q.comments[0]!.hidden).toBe(0);
  });
});
