import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { pruneExpired } from "../src/maintenance";
import { createTestAccount, issueTestSession } from "./helpers";

describe("pruneExpired", () => {
  it("removes stale sessions, expired handle releases, and dead device codes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const acct = await createTestAccount();
    await issueTestSession(acct); // fresh session — must survive
    // Stale session (aged 91 days)
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES ('stalehash', ?, ?, ?)"
    ).bind(acct.userId, now - 100 * 86400, now - 91 * 86400).run();
    // Expired + live handle releases
    await env.DB.prepare("INSERT INTO handle_releases (handle, released_at) VALUES ('oldname', ?)").bind(now - 31 * 86400).run();
    await env.DB.prepare("INSERT INTO handle_releases (handle, released_at) VALUES ('newname', ?)").bind(now - 1 * 86400).run();
    // Expired device code
    await env.DB.prepare(
      "INSERT INTO device_codes (device_code, user_code, expires_at, created_at) VALUES ('dead', 'XXXX-XXXX', ?, ?)"
    ).bind(now - 3600, now - 4500).run();

    await pruneExpired(env.DB, now);

    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(acct.userId).first<{ n: number }>();
    expect(sessions!.n).toBe(1); // fresh survives, stale gone
    const releases = await env.DB.prepare("SELECT handle FROM handle_releases").all();
    expect(releases.results.map((r: any) => r.handle)).toEqual(["newname"]);
    const codes = await env.DB.prepare("SELECT count(*) AS n FROM device_codes WHERE device_code = 'dead'").first<{ n: number }>();
    expect(codes!.n).toBe(0);
  });
});
