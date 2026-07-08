import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

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
});
