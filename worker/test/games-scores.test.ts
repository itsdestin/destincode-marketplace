import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

// Solo leaderboards (games spec §6.1). Covers the submit/keep-the-best rule,
// the sanity bounds (§6.4 accepts forgeable scores but not impossible ones),
// and friends-only ranking including the "you, alone" state (§6.5).

async function post(token: string, body: unknown) {
  return SELF.fetch("https://test.local/games/scores", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function board(token: string, game: string) {
  const res = await SELF.fetch(`https://test.local/games/scores/${game}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ game: string; you: any; entries: any[] }>;
}
async function befriend(aId: string, bId: string) {
  const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
  await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
    .bind(low, high, Math.floor(Date.now() / 1000)).run();
}

describe("POST /games/scores", () => {
  it("requires a session", async () => {
    const res = await SELF.fetch("https://test.local/games/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "flappy", score: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("keeps the best and counts every run", async () => {
    const a = await createTestAccount();
    const token = await issueTestSession(a);

    const first = await post(token, { game: "flappy", score: 12 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ best: 12, runs: 1, is_best: true });

    // A worse run must not lower the board, but it is still a run.
    const worse = await post(token, { game: "flappy", score: 3 });
    expect(await worse.json()).toMatchObject({ best: 12, runs: 2, is_best: false });

    const better = await post(token, { game: "flappy", score: 40 });
    expect(await better.json()).toMatchObject({ best: 40, runs: 3, is_best: true });

    // Games do not share a board.
    const other = await post(token, { game: "twenty-forty-eight", score: 2048 });
    expect(await other.json()).toMatchObject({ best: 2048, runs: 1, is_best: true });
  });

  it("rejects unknown games so a typo cannot create rows", async () => {
    const a = await createTestAccount();
    const token = await issueTestSession(a);
    for (const game of ["chess", "connect-four", "flappybird", ""]) {
      const res = await post(token, { game, score: 1 });
      expect(res.status).toBe(400);
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_scores WHERE user_id = ?")
      .bind(a.userId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("rejects scores that no honest run could produce", async () => {
    const a = await createTestAccount();
    const token = await issueTestSession(a);
    // Infinity/NaN are not representable in JSON — they serialize to null,
    // which must be rejected just as firmly as the numeric junk below.
    for (const score of [-1, 1.5, 1_000_000_001, 1e20, null, "12", true]) {
      const res = await post(token, { game: "flappy", score });
      expect(res.status).toBe(400);
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_scores WHERE user_id = ?")
      .bind(a.userId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});

describe("GET /games/scores/:game", () => {
  it("shows you alone when you have no friends, and nothing when you have no score", async () => {
    const a = await createTestAccount();
    const token = await issueTestSession(a);

    const empty = await board(token, "flappy");
    expect(empty.entries).toEqual([]);
    expect(empty.you).toBeNull(); // the §6.5 "no score yet" state, unambiguous

    await post(token, { game: "flappy", score: 7 });
    const alone = await board(token, "flappy");
    expect(alone.entries).toHaveLength(1);
    expect(alone.entries[0]).toMatchObject({ id: a.userId, best_score: 7, rank: 1, is_you: true });
    expect(alone.you.rank).toBe(1);
  });

  it("ranks friends' bests and excludes strangers", async () => {
    const me = await createTestAccount();
    const friend = await createTestAccount();
    const stranger = await createTestAccount();
    await befriend(me.userId, friend.userId);
    const myToken = await issueTestSession(me);

    await post(myToken, { game: "flappy", score: 10 });
    await post(await issueTestSession(friend), { game: "flappy", score: 25 });
    await post(await issueTestSession(stranger), { game: "flappy", score: 9999 });

    const b = await board(myToken, "flappy");
    expect(b.entries.map((e) => e.id)).toEqual([friend.userId, me.userId]); // highest first
    expect(b.entries.map((e) => e.rank)).toEqual([1, 2]);
    expect(b.entries.find((e) => e.id === stranger.userId)).toBeUndefined();
    expect(b.you).toMatchObject({ id: me.userId, rank: 2, is_you: true });
  });

  it("breaks ties in favor of whoever got there first", async () => {
    const me = await createTestAccount();
    const early = await createTestAccount();
    await befriend(me.userId, early.userId);
    const now = Math.floor(Date.now() / 1000);
    // Written directly so best_at is controlled: same score, different times.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at) VALUES (?, 'twenty-forty-eight', 512, ?, 1, ?)")
        .bind(me.userId, now, now),
      env.DB.prepare("INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at) VALUES (?, 'twenty-forty-eight', 512, ?, 1, ?)")
        .bind(early.userId, now - 500, now - 500),
    ]);
    const b = await board(await issueTestSession(me), "twenty-forty-eight");
    expect(b.entries.map((e) => e.id)).toEqual([early.userId, me.userId]);
  });

  it("rejects an unknown game id in the path", async () => {
    const token = await issueTestSession(await createTestAccount());
    const res = await SELF.fetch("https://test.local/games/scores/chess", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

// All-games bests (the games picker's one-call read). Own bests only — this is
// deliberately NOT a board, so nothing a friend did may appear here.
describe("GET /games/scores (every solo game at once)", () => {
  async function mine(token: string) {
    const res = await SELF.fetch("https://test.local/games/scores", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, { best: number; best_at: number; runs: number }>>;
  }

  it("requires a session", async () => {
    const res = await SELF.fetch("https://test.local/games/scores");
    expect(res.status).toBe(401);
  });

  it("returns an empty object, not an error, before you have played anything", async () => {
    const token = await issueTestSession(await createTestAccount());
    expect(await mine(token)).toEqual({});
  });

  it("returns your best in every game you have played", async () => {
    const token = await issueTestSession(await createTestAccount());
    await post(token, { game: "flappy", score: 31 });
    await post(token, { game: "flappy", score: 4 });          // a run, not a best
    await post(token, { game: "twenty-forty-eight", score: 2048 });

    const all = await mine(token);
    expect(Object.keys(all).sort()).toEqual(["flappy", "twenty-forty-eight"]);
    expect(all.flappy).toMatchObject({ best: 31, runs: 2 });
    expect(all.flappy!.best_at).toBeGreaterThan(0);
    expect(all["twenty-forty-eight"]).toMatchObject({ best: 2048, runs: 1 });
  });

  it("never includes a friend's score — this is your bests, not a board", async () => {
    const me = await createTestAccount();
    const friend = await createTestAccount();
    await befriend(me.userId, friend.userId);
    const myToken = await issueTestSession(me);
    await post(await issueTestSession(friend), { game: "flappy", score: 9999 });

    // The friend outscores me and would top the /games/scores/flappy board...
    expect((await board(myToken, "flappy")).entries.map((e) => e.id)).toEqual([friend.userId]);
    // ...but has no place in my own bests.
    expect(await mine(myToken)).toEqual({});

    await post(myToken, { game: "flappy", score: 5 });
    expect(await mine(myToken)).toMatchObject({ flappy: { best: 5, runs: 1 } });
  });

  it("filters out a row left behind by a game that no longer exists", async () => {
    const me = await createTestAccount();
    const token = await issueTestSession(me);
    await post(token, { game: "flappy", score: 12 });
    // Written directly: the route rejects unknown ids, so the only way such a
    // row exists is a game that WAS in SOLO_GAMES and later left it.
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO game_scores (user_id, game, best_score, best_at, runs, updated_at) VALUES (?, 'retired-game', 999, ?, 3, ?)"
    ).bind(me.userId, now, now).run();

    const all = await mine(token);
    expect(Object.keys(all)).toEqual(["flappy"]);
    expect(all["retired-game"]).toBeUndefined();
  });

  it("does not shadow GET /games/scores/:game", async () => {
    const token = await issueTestSession(await createTestAccount());
    await post(token, { game: "flappy", score: 8 });
    // Both shapes must still resolve to their own handler.
    const one = await board(token, "flappy");
    expect(one.game).toBe("flappy");
    expect(one.you).toMatchObject({ best_score: 8 });
    expect(await mine(token)).toEqual({ flappy: { best: 8, best_at: one.you.best_at, runs: 1 } });
  });
});
