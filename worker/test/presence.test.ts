import { env, SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

// [env.test.vars] sets PRESENCE_STALE_MS=800 so staleness is reachable in-test;
// production defaults to the generous rollout threshold (see presence-room.ts).
const STALE_MS = 800;
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

describe("PresenceRoom", () => {
  it("rejects unauthenticated upgrades", async () => {
    const res = await SELF.fetch("https://test.local/social/presence", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("friends see each other; strangers are mutually invisible", async () => {
    const a = await createTestAccount({ handle: `pa${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `pb${Date.now() % 100000}` });
    const s = await createTestAccount(); // stranger
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    const snapA = await nextMessage(wsA, "presence");
    expect(snapA.users).toEqual([]); // nobody online yet

    const joinedPromise = nextMessage(wsA, "user-joined");
    const wsB = await connect(await issueTestSession(b));
    const snapB = await nextMessage(wsB, "presence");
    expect(snapB.users.map((u: any) => u.id)).toEqual([a.userId]); // B sees online friend A
    expect((await joinedPromise).user.id).toBe(b.userId);          // A is told B joined

    const wsS = await connect(await issueTestSession(s));
    const snapS = await nextMessage(wsS, "presence");
    expect(snapS.users).toEqual([]); // stranger sees no one
    wsA.close(); wsB.close(); wsS.close();
  });

  it("relays challenges between friends only", async () => {
    const a = await createTestAccount({ handle: `ca${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `cb${Date.now() % 100000}` });
    const s = await createTestAccount();
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");

    const challengeAtB = nextMessage(wsB, "challenge");
    wsA.send(JSON.stringify({ type: "challenge", target: b.userId, gameType: "connect-four", code: "ABC123" }));
    const ch = await challengeAtB;
    expect(ch.from.id).toBe(a.userId);
    expect(ch.code).toBe("ABC123");

    // Non-friend target → challenge-failed back to sender
    const failed = nextMessage(wsA, "challenge-failed");
    wsA.send(JSON.stringify({ type: "challenge", target: s.userId, gameType: "connect-four", code: "XYZ789" }));
    expect((await failed).target).toBe(s.userId);
    wsA.close(); wsB.close();
  });

  it("last disconnect writes last_seen_at and notifies online friends", async () => {
    const a = await createTestAccount({ handle: `la${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `lb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");
    const leftPromise = nextMessage(wsA, "user-left");
    wsB.close(1000, "bye");
    expect((await leftPromise).id).toBe(b.userId);
    // last_seen_at written (eventually consistent within the close handler)
    const row = await env.DB.prepare("SELECT last_seen_at FROM users WHERE id = ?").bind(b.userId).first<{ last_seen_at: number | null }>();
    expect(row!.last_seen_at).not.toBeNull();
    wsA.close();
  });

  it("a block poke makes both sides disappear from each other's presence", async () => {
    const a = await createTestAccount({ handle: `ba${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `bb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const tokenA = await issueTestSession(a);
    const wsA = await connect(tokenA);
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");

    const refreshedA = nextMessage(wsA, "presence"); // poke → fresh snapshot
    const res = await SELF.fetch("https://test.local/social/blocks", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: b.userId }),
    });
    expect(res.status).toBe(200);
    expect((await refreshedA).users).toEqual([]); // B gone from A's view
    wsA.close(); wsB.close();
  });

  it("status updates reach online friends", async () => {
    const a = await createTestAccount({ handle: `sa${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `sb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");
    const statusAtA = nextMessage(wsA, "user-status");
    wsB.send(JSON.stringify({ type: "status", status: "in-game" }));
    const st = await statusAtA;
    expect(st.id).toBe(b.userId);
    expect(st.status).toBe("in-game");
    wsA.close(); wsB.close();
  });

  it("relays challenge-response to the challenger; drops responses to non-friends", async () => {
    const a = await createTestAccount({ handle: `ra${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `rb${Date.now() % 100000}` });
    const s = await createTestAccount(); // stranger — must never receive a relay
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");
    const wsS = await connect(await issueTestSession(s));
    await nextMessage(wsS, "presence");

    // B responds to A's (implied) challenge — A receives it with from = B's card.
    const respAtA = nextMessage(wsA, "challenge-response");
    wsB.send(JSON.stringify({ type: "challenge-response", to: a.userId, accept: true }));
    const resp = await respAtA;
    expect(resp.from.id).toBe(b.userId);
    expect(resp.accept).toBe(true);

    // A response addressed to a NON-friend is silently dropped — nothing
    // reaches the stranger (short timeout expecting rejection).
    const atStranger = nextMessage(wsS, "challenge-response", 500);
    wsB.send(JSON.stringify({ type: "challenge-response", to: s.userId, accept: true }));
    await expect(atStranger).rejects.toThrow();
    wsA.close(); wsB.close(); wsS.close();
  });

  it("multi-device: joins once, leaves on last disconnect, later sockets inherit status", async () => {
    const a = await createTestAccount({ handle: `ma${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `mb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const tokenA = await issueTestSession(a);
    const tokenB = await issueTestSession(b);
    const wsA = await connect(tokenA);
    await nextMessage(wsA, "presence");

    // First B connection → exactly one user-joined at A.
    const joined = nextMessage(wsA, "user-joined");
    const wsB1 = await connect(tokenB);
    await nextMessage(wsB1, "presence");
    expect((await joined).user.id).toBe(b.userId);

    // Second B connection → NO second user-joined (account already online).
    const joinedAgain = nextMessage(wsA, "user-joined", 500);
    const wsB2 = await connect(tokenB);
    await nextMessage(wsB2, "presence");
    await expect(joinedAgain).rejects.toThrow();

    // B goes in-game from socket 1 — friends are told.
    const statusAtA = nextMessage(wsA, "user-status");
    wsB1.send(JSON.stringify({ type: "status", status: "in-game" }));
    expect((await statusAtA).status).toBe("in-game");

    // Socket 3 connects AFTER the status change — it must inherit "in-game"
    // (regression guard for the connect-path status inheritance fix).
    const wsB3 = await connect(tokenB);
    await nextMessage(wsB3, "presence");

    // Closing sockets 1 and 2 is NOT a leave — socket 3 is still open.
    const leftEarly = nextMessage(wsA, "user-left", 500);
    wsB1.close(1000, "bye"); wsB2.close(1000, "bye");
    await expect(leftEarly).rejects.toThrow();

    // A reconnects → fresh snapshot reads B's status from the ONLY remaining
    // socket (the inheriting socket 3): must show in-game, not idle.
    const wsA2 = await connect(tokenA);
    const snap = await nextMessage(wsA2, "presence");
    expect(snap.users).toEqual([expect.objectContaining({ id: b.userId, status: "in-game" })]);

    // Last B socket closes → user-left fires.
    const left = nextMessage(wsA, "user-left");
    wsB3.close(1000, "bye");
    expect((await left).id).toBe(b.userId);
    wsA.close(); wsA2.close();
  });

  // ---- liveness / ghost-socket coverage (2026-07-22 stuck-online investigation) ----

  it("a ghost socket does not suppress user-left when the last live socket closes", async () => {
    const a = await createTestAccount({ handle: `ga${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `gb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const tokenB = await issueTestSession(b);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB1 = await connect(tokenB); // becomes the ghost: never pings again
    await nextMessage(wsB1, "presence");
    const wsB2 = await connect(tokenB);
    await nextMessage(wsB2, "presence");

    // Age both B sockets past the threshold, then revive ONLY socket 2 —
    // socket 1 is now a ghost (like a machine that slept without a close frame).
    await sleep(STALE_MS + 300);
    ping(wsB2);
    await sleep(50); // let the liveness stamp land before the close races it

    // Closing the last LIVE socket must announce the account offline even
    // though the ghost is still registered — the pre-fix code counted the
    // ghost and suppressed user-left forever (the stuck-"Online" bug).
    const left = nextMessage(wsA, "user-left");
    wsB2.close(1000, "bye");
    expect((await left).id).toBe(b.userId);

    // A challenge aimed at a ghost-only account must fail fast, not relay
    // into the void and leave the challenger on the waiting screen forever.
    const failed = nextMessage(wsA, "challenge-failed");
    wsA.send(JSON.stringify({ type: "challenge", target: b.userId, gameType: "connect-four", code: "GHOST1" }));
    expect((await failed).target).toBe(b.userId);
    wsA.close();
  });

  it("the alarm evicts stale sockets, announces user-left, and writes last_seen_at", async () => {
    const a = await createTestAccount({ handle: `ea${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `eb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const tokenA = await issueTestSession(a);
    const wsA = await connect(tokenA);
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");

    // Age everyone past the threshold, then revive only A.
    await sleep(STALE_MS + 300);
    ping(wsA);
    await sleep(50);

    const left = nextMessage(wsA, "user-left");
    const closed = new Promise<void>((res) => wsB.addEventListener("close", () => res()));
    expect(await runDurableObjectAlarm(presenceStub())).toBe(true);
    expect((await left).id).toBe(b.userId); // friends are told
    await closed;                           // the ghost socket is really closed

    // The eviction runs the same offline path as a clean close: last_seen_at lands.
    const row = await env.DB.prepare("SELECT last_seen_at FROM users WHERE id = ?")
      .bind(b.userId).first<{ last_seen_at: number | null }>();
    expect(row!.last_seen_at).not.toBeNull();

    // A fresh snapshot agrees: B is offline.
    const wsA2 = await connect(tokenA);
    const snap = await nextMessage(wsA2, "presence");
    expect(snap.users).toEqual([]);
    wsA.close(); wsA2.close();
  });

  it("a socket that keeps pinging is never evicted", async () => {
    const a = await createTestAccount({ handle: `ka${Date.now() % 100000}` });
    const b = await createTestAccount({ handle: `kb${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    const wsA = await connect(await issueTestSession(a));
    await nextMessage(wsA, "presence");
    const wsB = await connect(await issueTestSession(b));
    await nextMessage(wsB, "presence");

    // Heartbeat both sockets across ~2× the threshold.
    for (let i = 0; i < 6; i++) {
      await sleep(250);
      ping(wsA); ping(wsB);
    }

    const left = nextMessage(wsA, "user-left", 500);
    expect(await runDurableObjectAlarm(presenceStub())).toBe(true);
    await expect(left).rejects.toThrow(); // nobody evicted

    // B's socket is genuinely alive: a status update still relays to A.
    const status = nextMessage(wsA, "user-status");
    wsB.send(JSON.stringify({ type: "status", status: "in-game" }));
    expect((await status).status).toBe("in-game");
    wsA.close(); wsB.close();
  });
});
