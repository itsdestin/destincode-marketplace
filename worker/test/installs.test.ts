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

// Batch form (2026-08-28). Exists because the app must RECONCILE: the server
// only ever learned about installs made while signed in, so plugins that ship
// with YouCoded (auto-installed at launch, never through the marketplace's
// Install button), and anything installed while signed out or on another
// device, had no row — and the install gate on POST /thumbs then refused a vote
// on a plugin the user demonstrably has. Sending them one at a time would be N
// round-trips on every sign-in and would burn N rate-limit ticks.
describe("POST /installs — batch", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  const postBatch = (token: string | null, body: unknown) =>
    SELF.fetch("https://test.local/installs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it("records many ids in one call and reports how many were new", async () => {
    const { token, account } = await seedUserAndToken();
    const res = await postBatch(token, { plugin_ids: ["a", "b", "wecoded-themes-plugin"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 3 });
    const { results } = await env.DB.prepare("SELECT plugin_id FROM installs WHERE user_id = ? ORDER BY plugin_id")
      .bind(account.userId).all<{ plugin_id: string }>();
    expect(results.map((r) => r.plugin_id)).toEqual(["a", "b", "wecoded-themes-plugin"]);
  });

  it("is idempotent and deduplicates within one call", async () => {
    const { token, account } = await seedUserAndToken();
    await postBatch(token, { plugin_ids: ["a", "a", "b"] });
    await postBatch(token, { plugin_ids: ["a", "b"] });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE user_id = ?")
      .bind(account.userId).first<{ n: number }>();
    expect(row).toEqual({ n: 2 });
  });

  it("does not move installed_at on a re-report", async () => {
    const { token, account } = await seedUserAndToken();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, 'a', 111)")
      .bind(account.userId).run();
    await postBatch(token, { plugin_ids: ["a"] });
    const row = await env.DB.prepare("SELECT installed_at FROM installs WHERE user_id = ? AND plugin_id = 'a'")
      .bind(account.userId).first<{ installed_at: number }>();
    // Reconcile runs on every sign-in; bumping the date would rewrite history.
    expect(row).toEqual({ installed_at: 111 });
  });

  it("401s without a token, and 400s on a bad id or an oversized list", async () => {
    expect((await postBatch(null, { plugin_ids: ["a"] })).status).toBe(401);
    const { token } = await seedUserAndToken();
    expect((await postBatch(token, { plugin_ids: ["ok", ""] })).status).toBe(400);
    expect((await postBatch(token, { plugin_ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect((await postBatch(token, { plugin_ids: tooMany })).status).toBe(400);
  });

  it("still accepts the single-id form", async () => {
    const { token, account } = await seedUserAndToken();
    const res = await postBatch(token, { plugin_id: "solo" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE user_id = ?")
      .bind(account.userId).first<{ n: number }>();
    expect(row).toEqual({ n: 1 });
  });
});

// The sign-in reconcile reports EVERYTHING the client holds, including things that
// are not marketplace listings at all. Rejecting the whole call for one of those
// would record no installs and leave every vote refused with "must install plugin
// before voting" — so unknown ids are dropped and the response says how many.
describe("POST /installs — batch against a populated catalog", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs", "catalog_items"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    for (const id of ["real-a", "real-b"]) {
      await env.DB.prepare("INSERT INTO catalog_items (id, source, item_type, deprecated, updated_at, entry_json) VALUES (?, 'wecoded', 'plugin', 0, 1, '{}')")
        .bind(id).run();
    }
  });

  const postBatch = (token: string, body: unknown) =>
    SELF.fetch("https://test.local/installs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("records the listings it knows, drops the rest, and says how many it dropped", async () => {
    const { token, account } = await seedUserAndToken();
    const res = await postBatch(token, { plugin_ids: ["real-a", "my-own-plugin", "theme:golden-sunbreak", "real-b"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 3, skipped: 1 });
    const { results } = await env.DB.prepare("SELECT plugin_id FROM installs WHERE user_id = ? ORDER BY plugin_id")
      .bind(account.userId).all<{ plugin_id: string }>();
    expect(results.map((r) => r.plugin_id)).toEqual(["real-a", "real-b", "theme:golden-sunbreak"]);
  });

  it("survives a reconcile in which nothing is a known listing", async () => {
    const { token } = await seedUserAndToken();
    const res = await postBatch(token, { plugin_ids: ["nope-one", "nope-two"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 0, skipped: 2 });
  });
});
