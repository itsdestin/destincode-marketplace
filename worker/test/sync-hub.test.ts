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
