// Games arcade HTTP surface (§6.1 solo leaderboards, §6.2 records read).
// Spec: docs/active/specs/2026-08-30-games-arcade-design.md.
//
// Every route is session-gated. There is deliberately NO public read: both
// boards are friends-only, so an unauthenticated caller has no board to see.
//
// Head-to-head results are NOT posted here — they arrive over the presence
// socket, because that is the only place the worker has both players
// authenticated at once (§6.2, src/social/presence-room.ts). This module only
// READS them.
//
// ONE router for every route in this feature — same reason as feedback/routes.ts:
// a second router is easy to write and easy to forget to app.route(), and the
// failure is silent (tests green, 404 in production).
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest, tooMany } from "../lib/errors";
import { parseJsonBody } from "../lib/parse-json";
import { checkRateLimit } from "../lib/rate-limit";
import type { UserCard } from "../social/graph";
import { isSoloGame, isValidScore, MAX_SCORE, SOLO_GAMES } from "./registry";
import { loadRecords } from "./records";

export const gameRoutes = new Hono<HonoEnv>();

/** One row on the friends leaderboard. */
interface BoardEntry extends UserCard {
  best_score: number;
  best_at: number;   // unix seconds, when the best was set
  rank: number;      // 1-based; computed here so every client agrees on the tie rule
  is_you: boolean;
}

// POST /games/scores { game, score } → { ok, best, runs, is_best }
//
// Keeps the BEST, never appends history (§6.1). A submission that does not beat
// the stored best still counts as a run and still refreshes updated_at, so the
// counter stays honest without the row pretending the score improved.
gameRoutes.post("/games/scores", requireAuth, async (c) => {
  const me = c.get("userId");
  // Cheap ceiling on an unmetered write. A real player finishes a Flappy run in
  // seconds, so 300/hour is far above honest play and far below what it would
  // take to make the table a cost problem.
  if (!(await checkRateLimit(`game-score:${me}`, 300, 3600))) {
    throw tooMany("too many score submissions per hour");
  }
  const body = await parseJsonBody<{ game?: unknown; score?: unknown }>(c);
  if (!isSoloGame(body.game)) {
    throw badRequest(`game must be one of: ${SOLO_GAMES.join(", ")}`);
  }
  if (!isValidScore(body.score)) {
    // Specific and accurate: the caller is told exactly what shape is accepted
    // rather than a guessed cause (workspace error-message standard).
    throw badRequest(`score must be a whole number between 0 and ${MAX_SCORE}`);
  }
  const game = body.game;
  const score = body.score;
  const now = Math.floor(Date.now() / 1000);

  // Read the previous best BEFORE the write, purely so the response can say
  // "this run became your best". The stored value is still decided atomically
  // by the upsert below — this read only informs the end-of-run screen, and the
  // only way it could be stale is one account submitting two runs at the same
  // instant, which one client playing one game cannot do.
  const before = await c.env.DB
    .prepare("SELECT best_score FROM game_scores WHERE user_id = ? AND game = ?")
    .bind(me, game)
    .first<{ best_score: number }>();
  const isBest = score > (before?.best_score ?? -1);

  // One statement does insert-or-improve. WHY a single upsert rather than
  // read-then-write: two runs finishing at once would both read the old best
  // and the loser's write would clobber the winner's. The MAX() in the DO
  // UPDATE makes the outcome the same whichever order they land in.
  //
  // best_at only moves when the score actually improves — the CASE keeps the
  // original timestamp otherwise, because the leaderboard breaks ties in favor
  // of whoever got there FIRST and a re-submitted equal score must not steal
  // the tiebreak.
  await c.env.DB.prepare(
    `INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?4)
     ON CONFLICT (user_id, game) DO UPDATE SET
       best_at    = CASE WHEN ?3 > game_scores.best_score THEN ?4 ELSE game_scores.best_at END,
       best_score = MAX(game_scores.best_score, ?3),
       runs       = game_scores.runs + 1,
       updated_at = ?4`
  ).bind(me, game, score, now).run();

  const row = await c.env.DB
    .prepare("SELECT best_score, best_at, runs FROM game_scores WHERE user_id = ? AND game = ?")
    .bind(me, game)
    .first<{ best_score: number; best_at: number; runs: number }>();
  return c.json({
    ok: true,
    best: row?.best_score ?? score,
    best_at: row?.best_at ?? now,
    runs: row?.runs ?? 1,
    // "Did this run become your best?" — the one fact the end-of-run screen
    // needs and cannot work out for itself after the upsert.
    is_best: isBest,
  });
});

// GET /games/scores/:game → { game, you, entries }
//
// The caller's best plus their friends' bests, ranked. `you` is called out
// separately so the "you, alone" and "you have no score yet" states (§6.5) are
// unambiguous without the client scanning the list.
gameRoutes.get("/games/scores/:game", requireAuth, async (c) => {
  const me = c.get("userId");
  const game = c.req.param("game");
  if (!isSoloGame(game)) {
    throw badRequest(`game must be one of: ${SOLO_GAMES.join(", ")}`);
  }
  // Friends are resolved in SQL rather than with loadFriendIds() + an IN list:
  // it keeps this to one round trip and avoids building a bound-parameter list
  // whose length grows with the friend count. Blocks need no separate check —
  // blocking severs the friendship (social/routes.ts POST /social/blocks), so a
  // blocked account is not in `friendships` at all.
  //
  // NOTE: ?1/?2 are NUMBERED placeholders (?2 is reused three times). Do not mix
  // in a positional `?`, and renumber if you add a bind.
  //
  // The u.* list below is CARD_COLUMNS, table-qualified — keep in sync with
  // CARD_COLUMNS in social/graph.ts (same convention as GET /social/requests).
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.handle, u.avatar_url, s.best_score, s.best_at
     FROM game_scores s
     JOIN users u ON u.id = s.user_id
     WHERE s.game = ?1
       AND ( s.user_id = ?2
             OR EXISTS (SELECT 1 FROM friendships f
                        WHERE (f.user_low = ?2 AND f.user_high = s.user_id)
                           OR (f.user_high = ?2 AND f.user_low = s.user_id)) )
     ORDER BY s.best_score DESC, s.best_at ASC`
  ).bind(game, me).all<UserCard & { best_score: number; best_at: number }>();

  const entries: BoardEntry[] = (rows.results ?? []).map((r, i) => ({
    ...r,
    rank: i + 1,
    is_you: r.id === me,
  }));
  return c.json({
    game,
    you: entries.find((e) => e.is_you) ?? null,
    entries,
  });
});

// GET /games/records[?game=chess] → HeadToHead[]
//
// Every head-to-head record the caller holds. The friends list reads this once
// and joins it to the rows it already has (same flat-array convention as
// GET /social/friends), so a friend row can show "7-2 at chess" without a call
// per friend.
//
// Records survive an unfriend: this returns what actually happened, and the
// client only paints rows for people currently on the friends list.
gameRoutes.get("/games/records", requireAuth, async (c) => {
  const me = c.get("userId");
  const all = await loadRecords(c.env.DB, me);
  const filter = c.req.query("game");
  return c.json(filter ? all.filter((r) => r.game === filter) : all);
});
