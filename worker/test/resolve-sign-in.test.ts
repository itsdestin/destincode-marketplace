import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { resolveProviderSignIn } from "../src/db";
import { createTestAccount } from "./helpers";

describe("resolveProviderSignIn", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("creates an account + identity on first sign-in", async () => {
    const id = await resolveProviderSignIn(env.DB, "github", "555", {
      login: "newbie",
      avatar_url: "https://a.example/n.png",
    });
    expect(id).toMatch(/^acct_[0-9a-f]{32}$/);
    const user = await env.DB.prepare("SELECT display_name, avatar_url, handle FROM users WHERE id = ?")
      .bind(id).first<{ display_name: string; avatar_url: string | null; handle: string | null }>();
    expect(user).toEqual({ display_name: "newbie", avatar_url: "https://a.example/n.png", handle: null });
    const identity = await env.DB.prepare(
      "SELECT user_id, provider_login FROM identities WHERE provider = 'github' AND provider_user_id = '555'"
    ).first<{ user_id: string; provider_login: string }>();
    expect(identity).toEqual({ user_id: id, provider_login: "newbie" });
  });

  it("returns the same account and refreshes avatar/login on repeat sign-in, without touching display_name", async () => {
    const first = await resolveProviderSignIn(env.DB, "github", "555", { login: "newbie", avatar_url: null });
    // User customized their display name between sign-ins (Phase 2 PATCH /auth/profile).
    await env.DB.prepare("UPDATE users SET display_name = 'Custom Name' WHERE id = ?").bind(first).run();

    const second = await resolveProviderSignIn(env.DB, "github", "555", {
      login: "renamed-on-github",
      avatar_url: "https://a.example/new.png",
    });
    expect(second).toBe(first);
    const user = await env.DB.prepare("SELECT display_name, avatar_url FROM users WHERE id = ?")
      .bind(first).first<{ display_name: string; avatar_url: string | null }>();
    // display_name is user-owned after creation; avatar refreshes every sign-in.
    expect(user).toEqual({ display_name: "Custom Name", avatar_url: "https://a.example/new.png" });
    const identity = await env.DB.prepare(
      "SELECT provider_login FROM identities WHERE provider = 'github' AND provider_user_id = '555'"
    ).first<{ provider_login: string }>();
    expect(identity).toEqual({ provider_login: "renamed-on-github" });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it("converges concurrent first sign-ins onto one account with no orphaned users row", async () => {
    // The race: two first sign-ins both pass the fast-path identity SELECT
    // (neither sees a row), then both try to create the account. Simulate the
    // LOSER by wrapping the DB so its fast-path SELECT returns null even though
    // the winner's identity row already exists — exactly the loser's view of
    // the race window. No hooks needed in production code.
    const winner = await createTestAccount({ login: "winner", githubId: "77777" });

    let interceptedFastPath = false;
    const raceDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            // Only the FIRST identities SELECT (the fast path) is faked to
            // null; the post-batch re-read goes to the real DB.
            if (!interceptedFastPath && sql.includes("FROM identities")) {
              interceptedFastPath = true;
              return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement;
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

    const resolved = await resolveProviderSignIn(raceDb, "github", "77777", {
      login: "winner",
      avatar_url: null,
    });

    // The loser converged onto the winner's account...
    expect(interceptedFastPath).toBe(true);
    expect(resolved).toBe(winner.userId);
    // ...and cleaned up its own users row — exactly one account remains.
    const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual([winner.userId]);
    // The identity still points at the winner (ON CONFLICT DO NOTHING held).
    const identity = await env.DB.prepare(
      "SELECT user_id FROM identities WHERE provider = 'github' AND provider_user_id = '77777'"
    ).first<{ user_id: string }>();
    expect(identity).toEqual({ user_id: winner.userId });
  });
});
