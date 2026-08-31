// The worker's view of the arcade: which game ids exist, and what a plausible
// score looks like. Spec: docs/active/specs/2026-08-30-games-arcade-design.md §6.
//
// Kept in ONE module because two very different callers need the same answers —
// the HTTP routes (src/games/routes.ts) and the presence Durable Object
// (src/social/presence-room.ts). A second copy of the allowlist would let a
// game id be valid over the socket and invalid over HTTP.
//
// The DO cannot throw HTTPExceptions (there is no request to answer), so the
// validators here come in two flavors: predicates for the socket, and
// throw-on-bad wrappers for the routes.

/** Solo games — a run produces a score for the friends leaderboard (§6.1). */
export const SOLO_GAMES = ["flappy", "twenty-forty-eight"] as const;
/** Versus games — a match produces a win/loss/draw record (§6.2). */
export const VERSUS_GAMES = ["connect-four", "chess"] as const;

export type SoloGame = (typeof SOLO_GAMES)[number];
export type VersusGame = (typeof VERSUS_GAMES)[number];

/** WHY an allowlist rather than "any non-empty string": without one, a typo or
 *  a stale client creates leaderboard rows for a game that does not exist, and
 *  nothing ever cleans them up (there is no catalog to join against). */
export function isSoloGame(v: unknown): v is SoloGame {
  return typeof v === "string" && (SOLO_GAMES as readonly string[]).includes(v);
}

export function isVersusGame(v: unknown): v is VersusGame {
  return typeof v === "string" && (VERSUS_GAMES as readonly string[]).includes(v);
}

// Sanity ceiling, NOT anti-cheat (§6.4 accepts that scores are forgeable on a
// friends-only board). Its whole job is to stop a broken client from poisoning
// the board with Infinity, NaN, 1e308 or a 20-digit number that no honest run
// could reach and that no other row could ever beat. A billion is roughly 250x
// the theoretical maximum of a perfect 2048 game and astronomically past any
// Flappy pipe count, so it can never reject a real run.
export const MAX_SCORE = 1_000_000_000;

/** True only for a finite, non-negative, whole number within the ceiling. */
export function isValidScore(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_SCORE;
}

// A match id is opaque to the worker — it only has to be the same string on
// both clients (in the app: the PartyKit room code). Bounded so a hostile or
// broken client cannot push a megabyte into a primary key.
export const MAX_MATCH_ID_LENGTH = 128;

export function isValidMatchId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_MATCH_ID_LENGTH;
}

/** What one client claims happened to IT (not to the pair). */
export type Outcome = "win" | "loss" | "draw";

export function isOutcome(v: unknown): v is Outcome {
  return v === "win" || v === "loss" || v === "draw";
}

/** Two reports agree when they describe the SAME match from opposite seats:
 *  one win against one loss, or a draw against a draw. Anything else — most
 *  obviously both claiming a win — is a disagreement and records nothing
 *  (§6.2). */
export function reportsAgree(mine: Outcome, theirs: Outcome): boolean {
  if (mine === "draw") return theirs === "draw";
  if (mine === "win") return theirs === "loss";
  return theirs === "win";
}
