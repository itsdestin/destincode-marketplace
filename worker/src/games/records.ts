// D1 access for head-to-head records (§6.2/§6.3). Takes D1Database explicitly,
// same convention as src/db.ts and src/social/graph.ts — which is what lets the
// presence Durable Object and the HTTP routes share one implementation instead
// of each growing its own SQL.
import type { D1Database } from "@cloudflare/workers-types";
import { pairKey } from "../social/graph";
import type { VersusGame } from "./registry";

/** One opponent, one game, from the caller's point of view. */
export interface HeadToHead {
  opponent_id: string;
  game: string;
  wins: number;
  losses: number;
  draws: number;
  last_played_at: number;
}

/**
 * Record one settled match.
 *
 * Idempotency lives HERE and nowhere else: the row's primary key is
 * (user_low, user_high, game, match_id), so a client that retries its report
 * after a dropped socket writes the identical key and INSERT OR IGNORE makes
 * the retry a no-op. Returns whether this call was the one that actually
 * recorded it, so the caller can tell "recorded" from "already recorded" —
 * both are success, but only the first is news.
 *
 * `winner` is an account id, or null for a draw.
 */
export async function recordMatch(
  db: D1Database,
  opts: {
    a: string;
    b: string;
    game: VersusGame | string;
    matchId: string;
    winner: string | null;
    source: "attested" | "forfeit";
    atSec: number;
  }
): Promise<{ inserted: boolean }> {
  const [low, high] = pairKey(opts.a, opts.b);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO game_matches
         (user_low, user_high, game, match_id, winner, source, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(low, high, opts.game, opts.matchId, opts.winner, opts.source, opts.atSec)
    .run();
  return { inserted: (res.meta.changes ?? 0) > 0 };
}

/** Has this exact match already been settled? Cheap PK lookup — the guard that
 *  stops a post-settlement retry from opening a fresh attestation slot. */
export async function matchIsRecorded(
  db: D1Database,
  a: string,
  b: string,
  game: string,
  matchId: string
): Promise<boolean> {
  const [low, high] = pairKey(a, b);
  const row = await db
    .prepare(
      "SELECT 1 AS one FROM game_matches WHERE user_low = ? AND user_high = ? AND game = ? AND match_id = ?"
    )
    .bind(low, high, game, matchId)
    .first();
  return row !== null;
}

// The counted-on-read record. WHY no stored totals: see migrations/0007_games.sql
// — a second copy of the count is a second thing that can be wrong, and the
// ledger is small enough that counting is free.
//
// NOTE: ?1 is a NUMBERED placeholder — one bound value (me) reused five times.
// Do not mix in a positional `?` here, and renumber if you add a bind.
const RECORD_SELECT = `
  SELECT
    CASE WHEN m.user_low = ?1 THEN m.user_high ELSE m.user_low END AS opponent_id,
    m.game AS game,
    SUM(CASE WHEN m.winner = ?1 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN m.winner IS NOT NULL AND m.winner <> ?1 THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN m.winner IS NULL THEN 1 ELSE 0 END) AS draws,
    MAX(m.recorded_at) AS last_played_at
  FROM game_matches m
  WHERE m.user_low = ?1 OR m.user_high = ?1`;

/** Every record the caller holds, across all opponents and games. This is what
 *  the friends list reads to paint "you vs Jake, 7-2 at chess" on each row. */
export async function loadRecords(db: D1Database, me: string): Promise<HeadToHead[]> {
  const rows = await db
    .prepare(`${RECORD_SELECT} GROUP BY opponent_id, m.game ORDER BY last_played_at DESC`)
    .bind(me)
    .all<HeadToHead>();
  return rows.results ?? [];
}

/** The caller's record against ONE opponent in ONE game — what the DO sends
 *  back on the socket after it settles a match, so the losing/winning client
 *  can update its friend row without a round trip to HTTP. */
export async function loadRecordVs(
  db: D1Database,
  me: string,
  opponent: string,
  game: string
): Promise<HeadToHead> {
  const [low, high] = pairKey(me, opponent);
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN winner = ?1 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN winner IS NOT NULL AND winner <> ?1 THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws,
         MAX(recorded_at) AS last_played_at
       FROM game_matches
       WHERE user_low = ?2 AND user_high = ?3 AND game = ?4`
    )
    .bind(me, low, high, game)
    .first<{ wins: number | null; losses: number | null; draws: number | null; last_played_at: number | null }>();
  // SUM/MAX over zero rows is NULL, not 0 — same trap as voteTotals() in
  // feedback/routes.ts.
  return {
    opponent_id: opponent,
    game,
    wins: row?.wins ?? 0,
    losses: row?.losses ?? 0,
    draws: row?.draws ?? 0,
    last_played_at: row?.last_played_at ?? 0,
  };
}
