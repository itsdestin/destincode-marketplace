import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

// A rating target ("bad actor"). Its user_id is an opaque account id used only
// as a foreign key in installs/ratings/reports — it is not an authenticated
// caller, so it needs no session or github identity.
const BADACTOR = "acct_badactor00000000000000000000";

describe("POST /reports", () => {
  beforeEach(async () => {
    for (const t of ["sessions","identities","users","installs","ratings","reports"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("records a report", async () => {
    const reporter = await createTestAccount({ login: "reporter" });
    const token = await issueTestSession(reporter);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(BADACTOR, "badactor", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind(BADACTOR, "foo", now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
       VALUES (?, ?, 1, 'terrible thing', ?, ?, 0)`
    ).bind(BADACTOR, "foo", now, now).run();

    const res = await SELF.fetch("https://test.local/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating_user_id: BADACTOR, rating_plugin_id: "foo", reason: "harassment" }),
    });
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT * FROM reports").all<{ rating_user_id: string; reporter_user_id: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.reporter_user_id).toBe(reporter.userId);
  });
});

describe("DELETE /admin/ratings/:user_id/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of ["sessions","identities","users","installs","ratings","reports"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("403s for non-admins", async () => {
    // A github identity NOT in ADMIN_USER_IDS ("424242") → authenticated but not admin.
    const nonAdmin = await createTestAccount({ githubId: "1", login: "u" });
    const token = await issueTestSession(nonAdmin);
    const res = await SELF.fetch(`https://test.local/admin/ratings/${BADACTOR}/foo`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("hides the rating and marks reports resolved for admins", async () => {
    const admin = await createTestAccount({ githubId: "424242", login: "admin" });
    const token = await issueTestSession(admin);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(BADACTOR, "badactor", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind(BADACTOR, "foo", now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
       VALUES (?, 'foo', 1, 'bad', ?, ?, 0)`
    ).bind(BADACTOR, now, now).run();
    await env.DB.prepare(
      `INSERT INTO reports (id, rating_user_id, rating_plugin_id, reporter_user_id, created_at)
       VALUES ('r1', ?, 'foo', ?, ?)`
    ).bind(BADACTOR, admin.userId, now).run();

    const res = await SELF.fetch(`https://test.local/admin/ratings/${BADACTOR}/foo`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT hidden FROM ratings WHERE user_id=? AND plugin_id='foo'").bind(BADACTOR).first<{ hidden: number }>();
    expect(row?.hidden).toBe(1);
    const reportRow = await env.DB.prepare("SELECT resolution FROM reports WHERE id='r1'").first<{ resolution: string | null }>();
    expect(reportRow?.resolution).toBe("hidden");
  });
});
