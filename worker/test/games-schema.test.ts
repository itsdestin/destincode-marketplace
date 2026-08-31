import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount } from "./helpers";

// Schema-level guards for 0007_games.sql. These pin the constraints the route
// and Durable Object code RELY on rather than re-check — most importantly that
// one match can only ever produce one row.
describe("0007_games schema", () => {
  const now = () => Math.floor(Date.now() / 1000);

  async function pair() {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    return { a, b, low, high };
  }

  it("game_scores rejects a negative best_score", async () => {
    const a = await createTestAccount();
    await expect(
      env.DB.prepare("INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at) VALUES (?, 'flappy', -1, ?, 1, ?)")
        .bind(a.userId, now(), now()).run()
    ).rejects.toThrow();
  });

  it("game_matches enforces the canonical pair order", async () => {
    const { low, high } = await pair();
    // Reversed order violates CHECK (user_low < user_high) — this is what makes
    // "one pair is one row" true instead of merely conventional.
    await expect(
      env.DB.prepare(
        "INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', 'M1', NULL, 'attested', ?)"
      ).bind(high, low, now()).run()
    ).rejects.toThrow();
  });

  it("game_matches rejects a winner who is not one of the two players", async () => {
    const { low, high } = await pair();
    const outsider = await createTestAccount();
    await expect(
      env.DB.prepare(
        "INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', 'M2', ?, 'attested', ?)"
      ).bind(low, high, outsider.userId, now()).run()
    ).rejects.toThrow();
  });

  it("game_matches rejects an unknown source", async () => {
    const { low, high } = await pair();
    await expect(
      env.DB.prepare(
        "INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', 'M3', NULL, 'referee', ?)"
      ).bind(low, high, now()).run()
    ).rejects.toThrow();
  });

  it("the same match cannot be recorded twice", async () => {
    const { low, high } = await pair();
    const stmt = () => env.DB.prepare(
      "INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', 'DUPE', ?, 'attested', ?)"
    ).bind(low, high, low, now());
    await stmt().run();
    await expect(stmt().run()).rejects.toThrow(); // PRIMARY KEY (pair, game, match_id)
  });

  it("deleting a user cascades their scores and matches", async () => {
    const { a, low, high } = await pair();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at) VALUES (?, 'flappy', 5, ?, 1, ?)")
        .bind(a.userId, now(), now()),
      env.DB.prepare("INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', 'CASC', NULL, 'attested', ?)")
        .bind(low, high, now()),
    ]);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(a.userId).run();
    const scores = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_scores WHERE user_id = ?").bind(a.userId).first<{ n: number }>();
    const matches = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_matches WHERE match_id = 'CASC'").first<{ n: number }>();
    expect(scores!.n).toBe(0);
    expect(matches!.n).toBe(0);
  });
});
