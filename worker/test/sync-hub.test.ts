// SyncHub connect/auth tests (Plan 1b, Task 1). Mirrors presence.test.ts's
// SELF.fetch websocket-upgrade helpers. This task covers connect, auth, hello
// (empty replay) and ping/pong only — the signal relay is Task 2.
import { SELF } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

async function connect(token: string, device: string): Promise<WebSocket> {
  const res = await SELF.fetch(
    `https://test.local/sync/hub?device=${encodeURIComponent(device)}`,
    { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket, type: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === type) { clearTimeout(timer); ws.removeEventListener("message", handler); resolve(data); }
    };
    ws.addEventListener("message", handler);
  });
}

describe("sync hub — connect & auth", () => {
  it("rejects unauthenticated upgrades", async () => {
    const res = await SELF.fetch("https://test.local/sync/hub?device=a", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-websocket request", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await SELF.fetch("https://test.local/sync/hub?device=a", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("accepts an authenticated upgrade and sends hello with empty replay", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const ws = await connect(token, "Desktop-A");
    const hello = await nextMessage(ws, "hello");
    expect(hello.replay).toEqual([]);
    ws.close();
  });

  it("answers ping with pong", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const ws = await connect(token, "Desktop-A");
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ type: "ping" }));
    await nextMessage(ws, "pong");
    ws.close();
  });
});

// Task 2: signal relay + storage-backed replay ring. NOTE: createTestAccount
// takes an options object (or nothing) — the plan sketch's string arg is wrong
// for this repo; an internal seq counter guarantees per-call uniqueness.
describe("sync hub — relay & replay", () => {
  it("relays a signal to the account's OTHER devices, not the sender", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    // Await each hello right after its connect — a hello frame that arrives
    // before a 'message' listener is attached is dropped, and awaiting the
    // second connect would open that gap for the first socket (mirrors the
    // connect→await pattern presence.test.ts uses for every multi-device case).
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const b = await connect(token, "Desktop-B");
    await nextMessage(b, "hello");

    a.send(JSON.stringify({ type: "signal", kind: "space-updated", spaceKey: "youcoded-sync-personal" }));
    const got = await nextMessage(b, "signal");
    expect(got.kind).toBe("space-updated");
    expect(got.spaceKey).toBe("youcoded-sync-personal");
    expect(got.device).toBe("Desktop-A");
    expect(typeof got.at).toBe("number");
    // Sender must NOT receive its own signal back.
    await expect(nextMessage(a, "signal", 400)).rejects.toThrow();
    a.close(); b.close();
  });

  it("does not leak signals across accounts", async () => {
    const acct1 = await createTestAccount();
    const acct2 = await createTestAccount();
    const t1 = await issueTestSession(acct1);
    const t2 = await issueTestSession(acct2);
    const a = await connect(t1, "A");
    await nextMessage(a, "hello");
    const b = await connect(t2, "B");
    await nextMessage(b, "hello");
    a.send(JSON.stringify({ type: "signal", kind: "space-updated", spaceKey: "k" }));
    await expect(nextMessage(b, "signal", 400)).rejects.toThrow();
    a.close(); b.close();
  });

  it("drops disallowed kinds and malformed spaceKeys", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "A");
    await nextMessage(a, "hello");
    const b = await connect(token, "B");
    await nextMessage(b, "hello");
    a.send(JSON.stringify({ type: "signal", kind: "lease-acquired", spaceKey: "k" })); // not yet allowed
    a.send(JSON.stringify({ type: "signal", kind: "space-updated", spaceKey: 42 }));   // not a string
    a.send(JSON.stringify({ type: "signal", kind: "space-updated", spaceKey: "x".repeat(300) })); // too long
    await expect(nextMessage(b, "signal", 400)).rejects.toThrow();
    a.close(); b.close();
  });

  it("replays buffered signals to a reconnecting device", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "A");
    await nextMessage(a, "hello");
    a.send(JSON.stringify({ type: "signal", kind: "space-updated", spaceKey: "repo-1" }));
    // Give the DO a beat to persist the ring entry.
    await new Promise((r) => setTimeout(r, 100));
    const late = await connect(token, "B");
    const hello = await nextMessage(late, "hello");
    expect(hello.replay.length).toBe(1);
    expect(hello.replay[0].spaceKey).toBe("repo-1");
    a.close(); late.close();
  });
});

// Plan 2b Task 1: session leases. Leases are a DO-authoritative request/response
// message type ({type:"lease", op}), NOT client-relayed signals — so they never
// touch ALLOWED_KINDS or the replay ring. Each op returns a {type:"lease-result",
// reqId, ok, holder} frame; release/takeover/force-acquire also fan out a
// {type:"lease-event"} to the OTHER sockets.
let reqSeq = 0;
/** Send a lease op and resolve with the matching lease-result (by reqId, so
 *  interleaved ops on one socket can't cross-resolve). */
function leaseOp(
  ws: WebSocket,
  op: string,
  sessionId: string,
  deviceId: string,
  timeoutMs = 2000,
): Promise<any> {
  const reqId = `req-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for lease-result ${op}`)), timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "lease-result" && data.reqId === reqId) {
        clearTimeout(timer); ws.removeEventListener("message", handler); resolve(data);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "lease", op, sessionId, deviceId, reqId }));
  });
}

describe("sync hub — leases", () => {
  it("acquire on a free session returns ok:true with holder=self", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const res = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(res.ok).toBe(true);
    expect(res.holder.deviceId).toBe("dev-a");
    expect(res.holder.device).toBe("Desktop-A"); // the connection-pinned label
    expect(res.holder.expiresAt).toBeGreaterThan(Date.now());
    a.close();
  });

  it("acquire on a held session (other deviceId) returns ok:false with the holder", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const b = await connect(token, "Desktop-B");
    await nextMessage(b, "hello");

    const held = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(held.ok).toBe(true);

    const denied = await leaseOp(b, "acquire", "s1", "dev-b");
    expect(denied.ok).toBe(false);
    expect(denied.holder.deviceId).toBe("dev-a"); // reports the current holder
    a.close(); b.close();
  });

  it("re-acquire by the same deviceId succeeds (idempotent) and extends expiry", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");

    const first = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(first.ok).toBe(true);
    const second = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(second.ok).toBe(true);
    expect(second.holder.deviceId).toBe("dev-a");
    // Expiry is recomputed each acquire (server clock advances across the I/O
    // between ops, so the second is at least as late as the first).
    expect(second.holder.expiresAt).toBeGreaterThanOrEqual(first.holder.expiresAt);
    a.close();
  });

  it("renew by holder extends expiresAt; renew by non-holder returns ok:false", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const b = await connect(token, "Desktop-B");
    await nextMessage(b, "hello");

    const acq = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(acq.ok).toBe(true);

    const renewed = await leaseOp(a, "renew", "s1", "dev-a");
    expect(renewed.ok).toBe(true);
    expect(renewed.holder.deviceId).toBe("dev-a");
    expect(renewed.holder.expiresAt).toBeGreaterThanOrEqual(acq.holder.expiresAt);

    const stranger = await leaseOp(b, "renew", "s1", "dev-b");
    expect(stranger.ok).toBe(false);
    expect(stranger.holder.deviceId).toBe("dev-a"); // still held by dev-a
    a.close(); b.close();
  });

  it("release by holder frees it; release when free returns ok:true (idempotent)", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");

    const acq = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(acq.ok).toBe(true);

    const rel = await leaseOp(a, "release", "s1", "dev-a");
    expect(rel.ok).toBe(true);
    expect(rel.holder).toBeNull();

    // Releasing an already-free lease is a success no-op.
    const relAgain = await leaseOp(a, "release", "s1", "dev-a");
    expect(relAgain.ok).toBe(true);
    expect(relAgain.holder).toBeNull();

    // The session is genuinely free now — a different device can acquire it.
    const reacq = await leaseOp(a, "acquire", "s1", "dev-b");
    expect(reacq.ok).toBe(true);
    expect(reacq.holder.deviceId).toBe("dev-b");
    a.close();
  });

  // Lazy expiry: the DO stamps expiresAt = server-now + 300s at acquire time and
  // treats any lease with expiresAt <= now as free on the NEXT read (no alarms).
  //
  // Time-driving in @cloudflare/vitest-pool-workers: verified empirically that
  // vi.setSystemTime with { toFake: ["Date"] } DOES propagate into the DO's
  // Date.now() (the test module and the DO share the same workerd isolate's Date)
  // while leaving the real setTimeout used by leaseOp/nextMessage working. So we
  // drive the DO's clock directly: under-TTL keeps the lease held, over-TTL reads
  // it as free — exercising the `rec.expiresAt <= now` branch for real.
  it("expiry is lazy: a lease older than 300s reads as free", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const b = await connect(token, "Desktop-B");
    await nextMessage(b, "hello");

    const base = Date.now();
    const acq = await leaseOp(a, "acquire", "s-exp", "dev-a");
    expect(acq.ok).toBe(true); // stamped expiresAt ≈ base + 300000

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 290s later — still inside the TTL, so dev-a still holds it.
      vi.setSystemTime(base + 290_000);
      const stillHeld = await leaseOp(b, "acquire", "s-exp", "dev-b");
      expect(stillHeld.ok).toBe(false);
      expect(stillHeld.holder.deviceId).toBe("dev-a");

      // 310s later — past the 300s TTL, so the lease lazily reads as free and a
      // different device can take it.
      vi.setSystemTime(base + 310_000);
      const nowFree = await leaseOp(b, "acquire", "s-exp", "dev-b");
      expect(nowFree.ok).toBe(true);
      expect(nowFree.holder.deviceId).toBe("dev-b");
    } finally {
      vi.useRealTimers();
    }
    a.close(); b.close();
  });

  it("release broadcasts a lease-event {kind:'released'} to OTHER sockets, not the sender, and it does NOT enter the replay ring", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const a = await connect(token, "Desktop-A");
    await nextMessage(a, "hello");
    const b = await connect(token, "Desktop-B");
    await nextMessage(b, "hello");

    await leaseOp(a, "acquire", "s1", "dev-a");
    // Kick off the release and await its lease-event on the OTHER socket.
    const evP = nextMessage(b, "lease-event");
    const rel = await leaseOp(a, "release", "s1", "dev-a");
    expect(rel.ok).toBe(true);
    const ev = await evP;
    expect(ev.kind).toBe("released");
    expect(ev.sessionId).toBe("s1");
    expect(ev.device).toBe("Desktop-A");
    // Sender must NOT receive its own lease-event.
    await expect(nextMessage(a, "lease-event", 400)).rejects.toThrow();

    // A reconnecting device's hello replay must contain NO lease frames — a
    // replayed stale lease frame would lie about current lease state.
    const c = await connect(token, "Desktop-C");
    const hello = await nextMessage(c, "hello");
    const leaseish = (hello.replay as any[]).filter(
      (e) => e.type === "lease-event" || e.kind === "released",
    );
    expect(leaseish).toEqual([]);
    a.close(); b.close(); c.close();
  });

  it("cross-account isolation: a lease in room A is invisible in room B", async () => {
    const acct1 = await createTestAccount();
    const acct2 = await createTestAccount();
    const t1 = await issueTestSession(acct1);
    const t2 = await issueTestSession(acct2);
    const a = await connect(t1, "A");
    await nextMessage(a, "hello");
    const b = await connect(t2, "B");
    await nextMessage(b, "hello");

    const held = await leaseOp(a, "acquire", "s1", "dev-a");
    expect(held.ok).toBe(true);
    // Same sessionId + same deviceId string, but a DIFFERENT account/room: the
    // lease from room A must not be visible, so the acquire succeeds here.
    const other = await leaseOp(b, "acquire", "s1", "dev-a");
    expect(other.ok).toBe(true);
    expect(other.holder.device).toBe("B"); // stamped by room B's socket label
    a.close(); b.close();
  });
});
