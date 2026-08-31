import { env, SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

// Head-to-head records via mutual attestation over the presence socket
// (games spec §6.2) plus the forfeit case (§6.3).
//
// [env.test.vars] sets GAME_RESULT_TIMEOUT_MS=600 so the attestation window is
// reachable in-test; production uses the 2-minute default in presence-room.ts.
// PRESENCE_STALE_MS=800 is the presence liveness threshold (see presence.test.ts).
const RESULT_TIMEOUT_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ping = (ws: WebSocket) => ws.send(JSON.stringify({ type: "ping" }));
const presenceStub = () => env.PRESENCE.get(env.PRESENCE.idFromName("global"));

async function connect(token: string): Promise<WebSocket> {
  const res = await SELF.fetch("https://test.local/social/presence", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}
function nextMessage(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === type) { clearTimeout(timer); ws.removeEventListener("message", handler); resolve(data); }
    };
    ws.addEventListener("message", handler);
  });
}
async function befriend(aId: string, bId: string) {
  const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
  await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
    .bind(low, high, Math.floor(Date.now() / 1000)).run();
}
async function matchRows(matchId: string) {
  const rows = await env.DB.prepare("SELECT * FROM game_matches WHERE match_id = ?").bind(matchId)
    .all<{ user_low: string; user_high: string; winner: string | null; source: string }>();
  return rows.results ?? [];
}
const result = (game: string, matchId: string, opponent: string, outcome: string) =>
  JSON.stringify({ type: "game-result", game, match_id: matchId, opponent, outcome });

/** Two friends, both connected, past their opening presence snapshot. */
async function twoPlayers(tag: string) {
  const a = await createTestAccount();
  const b = await createTestAccount();
  await befriend(a.userId, b.userId);
  const wsA = await connect(await issueTestSession(a));
  await nextMessage(wsA, "presence");
  const wsB = await connect(await issueTestSession(b));
  await nextMessage(wsB, "presence");
  return { a, b, wsA, wsB, match: `M-${tag}-${Date.now() % 1000000}` };
}

describe("head-to-head attestation (§6.2)", () => {
  it("records the match when both players report and agree", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("agree");

    // A reports first: nothing is recorded yet, A is told it is waiting.
    const pending = nextMessage(wsA, "game-result-pending");
    wsA.send(result("chess", match, b.userId, "win"));
    expect(await pending).toMatchObject({ match_id: match, opponent: b.userId });
    expect(await matchRows(match)).toHaveLength(0);

    // B corroborates from the opposite seat → recorded, both are told.
    const recordAtA = nextMessage(wsA, "game-record");
    const recordAtB = nextMessage(wsB, "game-record");
    wsB.send(result("chess", match, a.userId, "loss"));

    expect(await recordAtA).toMatchObject({ opponent: b.userId, source: "attested", record: { wins: 1, losses: 0, draws: 0 } });
    expect(await recordAtB).toMatchObject({ opponent: a.userId, source: "attested", record: { wins: 0, losses: 1, draws: 0 } });

    const rows = await matchRows(match);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ winner: a.userId, source: "attested" });
    wsA.close(); wsB.close();
  });

  it("records a draw when both call it a draw", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("draw");
    wsA.send(result("connect-four", match, b.userId, "draw"));
    await nextMessage(wsA, "game-result-pending");
    const rec = nextMessage(wsA, "game-record");
    wsB.send(result("connect-four", match, a.userId, "draw"));
    expect(await rec).toMatchObject({ record: { wins: 0, losses: 0, draws: 1 } });
    expect((await matchRows(match))[0]!.winner).toBeNull();
    wsA.close(); wsB.close();
  });

  it("records NOTHING when the two reports disagree, and tells both players", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("dispute");
    wsA.send(result("chess", match, b.userId, "win"));
    await nextMessage(wsA, "game-result-pending");

    const disputedAtA = nextMessage(wsA, "game-result-disputed");
    const disputedAtB = nextMessage(wsB, "game-result-disputed");
    wsB.send(result("chess", match, a.userId, "win")); // both claim the win

    expect(await disputedAtA).toMatchObject({ match_id: match });
    expect(await disputedAtB).toMatchObject({ match_id: match });
    expect(await matchRows(match)).toHaveLength(0);

    // A client that corrects itself inside the window can still settle honestly.
    const rec = nextMessage(wsB, "game-record");
    wsB.send(result("chess", match, a.userId, "loss"));
    await rec;
    expect((await matchRows(match))[0]).toMatchObject({ winner: a.userId });
    wsA.close(); wsB.close();
  });

  it("records nothing when the second report never arrives inside the window", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("timeout");
    wsA.send(result("chess", match, b.userId, "win"));
    await nextMessage(wsA, "game-result-pending");

    // Let the attestation window close. Ping through it so the SOCKETS stay
    // live — this test is about the report expiring, not the players leaving.
    await sleep(RESULT_TIMEOUT_MS / 2 + 50); ping(wsA); ping(wsB);
    await sleep(RESULT_TIMEOUT_MS / 2 + 50); ping(wsA); ping(wsB);

    // B's late report finds an expired slot: it becomes a NEW lone report, not
    // a settlement.
    const pendingAtB = nextMessage(wsB, "game-result-pending");
    wsB.send(result("chess", match, a.userId, "loss"));
    await pendingAtB;
    expect(await matchRows(match)).toHaveLength(0);

    // The alarm sweeps the leftover slot out of storage.
    expect(await runDurableObjectAlarm(presenceStub())).toBe(true);
    wsA.close(); wsB.close();
  });

  it("a retried report counts once, before and after settlement", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("retry");

    // Same report three times from the same player — still one vote.
    for (let i = 0; i < 3; i++) {
      const p = nextMessage(wsA, "game-result-pending");
      wsA.send(result("chess", match, b.userId, "win"));
      await p;
    }
    expect(await matchRows(match)).toHaveLength(0);

    const rec = nextMessage(wsB, "game-record");
    wsB.send(result("chess", match, a.userId, "loss"));
    await rec;
    expect(await matchRows(match)).toHaveLength(1);

    // A retry AFTER settlement is answered with the record already earned —
    // never a second row, and never a "pending" that would hang forever.
    const again = nextMessage(wsA, "game-record");
    wsA.send(result("chess", match, b.userId, "win"));
    expect(await again).toMatchObject({ source: "already-recorded", record: { wins: 1, losses: 0 } });
    expect(await matchRows(match)).toHaveLength(1);
    wsA.close(); wsB.close();
  });

  it("rejects reports it cannot trust: strangers, unknown games, junk", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const stranger = await createTestAccount();
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");

    const cases: Array<[unknown, string]> = [
      [{ type: "game-result", game: "chess", match_id: "R1", opponent: stranger.userId, outcome: "win" }, "not-friends"],
      [{ type: "game-result", game: "flappy", match_id: "R2", opponent: b.userId, outcome: "win" }, "unknown-game"],
      [{ type: "game-result", game: "chess", match_id: "", opponent: b.userId, outcome: "win" }, "invalid-match-id"],
      [{ type: "game-result", game: "chess", match_id: "R3", opponent: a.userId, outcome: "win" }, "invalid-opponent"],
      [{ type: "game-result", game: "chess", match_id: "R4", opponent: b.userId, outcome: "victory" }, "invalid-outcome"],
    ];
    for (const [msg, reason] of cases) {
      const rejected = nextMessage(wsA, "game-result-rejected");
      wsA.send(JSON.stringify(msg));
      expect((await rejected).reason).toBe(reason);
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_matches WHERE match_id LIKE 'R_'").first<{ n: number }>();
    expect(rows!.n).toBe(0);
    wsA.close();
  });
});

describe("forfeits (§6.3)", () => {
  it("refuses a single report while the opponent is still connected", async () => {
    const { b, wsA, wsB, match } = await twoPlayers("forfeit-live");
    const rejected = nextMessage(wsA, "game-result-rejected");
    wsA.send(JSON.stringify({ type: "game-forfeit", game: "chess", match_id: match, opponent: b.userId }));
    expect(await rejected).toMatchObject({ reason: "opponent-still-connected" });
    expect(await matchRows(match)).toHaveLength(0);
    wsA.close(); wsB.close();
  });

  it("accepts it once the presence room independently sees the opponent gone", async () => {
    const { a, b, wsA, wsB, match } = await twoPlayers("forfeit-gone");

    // Wait for the room's OWN offline signal rather than assuming the close
    // landed — this is the state the forfeit claim is checked against.
    const left = nextMessage(wsA, "user-left");
    wsB.close(1000, "bye");
    expect((await left).id).toBe(b.userId);

    const rec = nextMessage(wsA, "game-record");
    wsA.send(JSON.stringify({ type: "game-forfeit", game: "chess", match_id: match, opponent: b.userId }));
    expect(await rec).toMatchObject({ source: "forfeit", record: { wins: 1, losses: 0 } });

    const rows = await matchRows(match);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ winner: a.userId, source: "forfeit" });

    // Retrying the forfeit does not stack a second win.
    const again = nextMessage(wsA, "game-record");
    wsA.send(JSON.stringify({ type: "game-forfeit", game: "chess", match_id: match, opponent: b.userId }));
    expect(await again).toMatchObject({ source: "already-recorded" });
    expect(await matchRows(match)).toHaveLength(1);
    wsA.close();
  });

  it("cannot be claimed against a non-friend", async () => {
    const a = await createTestAccount();
    const stranger = await createTestAccount(); // never connects, so "gone" is trivially true
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const rejected = nextMessage(wsA, "game-result-rejected");
    wsA.send(JSON.stringify({ type: "game-forfeit", game: "chess", match_id: "FF-STRANGER", opponent: stranger.userId }));
    expect((await rejected).reason).toBe("not-friends");
    expect(await matchRows("FF-STRANGER")).toHaveLength(0);
    wsA.close();
  });
});

describe("GET /games/records", () => {
  it("reads the running record from both sides of the pair", async () => {
    const me = await createTestAccount();
    const jake = await createTestAccount();
    await befriend(me.userId, jake.userId);
    const [low, high] = me.userId < jake.userId ? [me.userId, jake.userId] : [jake.userId, me.userId];
    const now = Math.floor(Date.now() / 1000);
    // 2 wins for me, 1 for jake, 1 draw — written directly so the read is
    // tested independently of the attestation path above.
    const rows: Array<[string, string | null, number]> = [
      ["G1", me.userId, now - 40],
      ["G2", me.userId, now - 30],
      ["G3", jake.userId, now - 20],
      ["G4", null, now - 10],
    ];
    await env.DB.batch(rows.map(([id, winner, at]) =>
      env.DB.prepare("INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'chess', ?, ?, 'attested', ?)")
        .bind(low, high, `REC-${id}-${now}`, winner, at)
    ));
    // One match in a different game, to prove the grouping is per game.
    await env.DB.prepare("INSERT INTO game_matches (user_low, user_high, game, match_id, winner, source, recorded_at) VALUES (?, ?, 'connect-four', ?, ?, 'attested', ?)")
      .bind(low, high, `REC-C4-${now}`, jake.userId, now).run();

    const read = async (token: string, query = "") => {
      const res = await SELF.fetch(`https://test.local/games/records${query}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      return res.json() as Promise<any[]>;
    };

    const mine = await read(await issueTestSession(me));
    expect(mine.find((r) => r.game === "chess")).toMatchObject({ opponent_id: jake.userId, wins: 2, losses: 1, draws: 1 });
    expect(mine.find((r) => r.game === "connect-four")).toMatchObject({ wins: 0, losses: 1, draws: 0 });

    // The same rows read from the other seat are the mirror image.
    const theirs = await read(await issueTestSession(jake));
    expect(theirs.find((r) => r.game === "chess")).toMatchObject({ opponent_id: me.userId, wins: 1, losses: 2, draws: 1 });

    const filtered = await read(await issueTestSession(me), "?game=chess");
    expect(filtered.every((r) => r.game === "chess")).toBe(true);
  });

  it("requires a session", async () => {
    const res = await SELF.fetch("https://test.local/games/records");
    expect(res.status).toBe(401);
  });
});
