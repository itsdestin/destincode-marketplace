// SyncHub connect/auth tests (Plan 1b, Task 1). Mirrors presence.test.ts's
// SELF.fetch websocket-upgrade helpers. This task covers connect, auth, hello
// (empty replay) and ping/pong only — the signal relay is Task 2.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
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
