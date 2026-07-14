// SyncGroupRoom — spec §6 of the cross-device-sync design (SyncHub).
// One instance PER ACCOUNT (idFromName(userId)): a user's own devices hold a
// WebSocket here and relay metadata-only sync signals to each other. This DO
// is an ACCELERANT, never a source of truth — devices reconcile via the git
// transport on connect, so losing this DO's state loses nothing.
// Deliberately different from social/PresenceRoom (one global room, friend
// graph in D1): SyncHub has no D1 dependency and no cross-account visibility.
import type { Env } from "../types";

interface Attachment {
  userId: string;
  device: string;
}

// Signal kinds devices may relay. Phase 2 (leases/takeover) extends this list
// — the relay/ring logic below is kind-agnostic on purpose.
const ALLOWED_KINDS = new Set(["space-updated"]);

// Ring buffer: last N relayed signals, replayed to a (re)connecting device so
// a brief disconnect misses nothing. Small on purpose — anything older is
// covered by the client's reconcile-on-connect (it syncs every space anyway).
const RING_MAX = 32;

interface RingEntry {
  kind: string;
  spaceKey: string;
  device: string;
  at: number;
}

// Session lease (Plan 2b, spec §3): at most one device may hold an interactive
// CC session at a time so two devices don't both --resume the same transcript
// and corrupt it. The lease KEY is deviceId (a stable per-install userData UUID
// from the message body); `device` is the human-readable label for UI. Leases
// are DO-authoritative request/response state — NOT client-relayed signals — so
// they never enter ALLOWED_KINDS or the replay ring (a replayed stale lease
// frame would lie about who holds the lease now).
interface LeaseRecord { deviceId: string; device: string; expiresAt: number; }
const LEASE_TTL_MS = 300_000; // spec §3: 30s heartbeat, 300s expiry — ten missed beats

export class SyncGroupRoom {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    // Identity arrives via internal headers set by the authenticated route —
    // this DO is never reachable without requireAuth having resolved the user.
    const userId = request.headers.get("X-Sync-User");
    const device = request.headers.get("X-Sync-Device") ?? "unknown";
    // Case-insensitive Upgrade check — the header value is spec-legal in any
    // case ("WebSocket"), and both the route and PresenceRoom lowercase it.
    if (!userId || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // Hibernation API — handlers below survive DO eviction. Tag = account id
    // (multi-device: N sockets, one tag) so getWebSockets(userId) finds them all.
    this.state.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId, device } satisfies Attachment);

    // hello carries the ring so a reconnecting device catches up on any signal
    // it missed while briefly disconnected. Empty on a fresh room.
    const ring = (await this.state.storage.get<RingEntry[]>("ring")) ?? [];
    this.safeSend(server, JSON.stringify({ type: "hello", replay: ring }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === "ping") {
      this.safeSend(ws, JSON.stringify({ type: "pong" }));
      return;
    }
    if (data.type === "signal") {
      await this.relaySignal(ws, data);
      return;
    }
    if (data.type === "lease") {
      await this.handleLease(ws, data);
      return;
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Nothing to persist — presence of a device is not tracked (that's the
    // social PresenceRoom's job for friends; sync needs no device roster).
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** send() can throw if the peer is mid-close; one bad socket must never
   *  strand the rest of a loop (same pitfall as PresenceRoom.safeSend and the
   *  transcript-watcher's readNewLines). Task 2's relay loop must route every
   *  send through this. */
  private safeSend(sock: WebSocket, msg: string): void {
    try { sock.send(msg); } catch { /* peer closing */ }
  }

  private async relaySignal(sender: WebSocket, data: any): Promise<void> {
    // Validate hard: this is the only client-writable path into the room, so
    // an unknown kind or a junk spaceKey must be dropped, never relayed/stored.
    if (!ALLOWED_KINDS.has(data.kind)) return;
    if (typeof data.spaceKey !== "string" || data.spaceKey.length === 0 || data.spaceKey.length > 200) return;

    // device is a human-readable LABEL, not authenticated identity — it comes
    // from the client-chosen ?device= query param at connect time. What IS
    // guaranteed: it's connection-pinned (read from the socket attachment set
    // in fetch(), not from the message body), so a client can't respoof it
    // per-message. Phase 2 lease logic must NOT key on it as verified/unique.
    // Null-guard matches presence-room.ts: webSocketMessage has no try/catch,
    // so a missing attachment would otherwise throw on an ungated path.
    const att = sender.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const entry: RingEntry = {
      kind: data.kind,
      spaceKey: data.spaceKey,
      device: att.device,
      at: Date.now(),
    };

    // Append to the replay ring and cap at RING_MAX. Stored in DO storage so it
    // survives hibernation — a device reconnecting after eviction still catches
    // up on recent signals via the hello frame.
    // Safe under concurrent signals: Durable Object "input gates" defer new
    // events while a storage op is in flight, and this get→push→put has no
    // other await between the read and the write — so no two relaySignal calls
    // can interleave and clobber each other's ring append.
    const ring = (await this.state.storage.get<RingEntry[]>("ring")) ?? [];
    ring.push(entry);
    await this.state.storage.put("ring", ring.slice(-RING_MAX));

    // Relay to every OTHER socket in this account's room. safeSend so one
    // closing peer can't strand the loop (same guard as PresenceRoom.safeSend).
    const frame = JSON.stringify({ type: "signal", ...entry });
    for (const sock of this.state.getWebSockets()) {
      if (sock === sender) continue;
      this.safeSend(sock, frame);
    }
  }

  private async handleLease(ws: WebSocket, data: any): Promise<void> {
    // Same null-guard discipline as relaySignal — webSocketMessage has no
    // try/catch, so a missing attachment on this ungated path must not throw.
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const { op, sessionId, deviceId, reqId } = data;
    // Validate hard: this is the only client-writable path into lease storage.
    if (typeof op !== "string") return;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 100) return;
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 100) return;

    const key = `lease:${sessionId}`;
    // Server time — spec §18 clock-skew rule: clients never compute expiry, so a
    // device with a fast/slow clock can't hold a lease longer or shorter than TTL.
    const now = Date.now();
    // Read the current record, then lazily treat an expired one as free. Because
    // the get→put below has no other await between them, the DO input gate keeps
    // two concurrent lease ops from interleaving (same discipline as the ring
    // append in relaySignal) — no alarms needed to reap expired leases.
    let rec = (await this.state.storage.get<LeaseRecord>(key)) ?? null;
    if (rec && rec.expiresAt <= now) rec = null; // lazy expiry

    let ok = false;
    if (op === "get") {
      // Read-only probe of current holder (post-lazy-expiry). Never mutates.
      ok = true;
    } else if (op === "acquire") {
      // Free OR already ours → (re)stamp a fresh TTL. Re-acquire is idempotent.
      if (!rec || rec.deviceId === deviceId) {
        rec = { deviceId, device: att.device, expiresAt: now + LEASE_TTL_MS };
        await this.state.storage.put(key, rec);
        ok = true;
      }
    } else if (op === "renew") {
      // Heartbeat: only the holder may extend; a non-holder renew is a no-op.
      if (rec && rec.deviceId === deviceId) {
        rec = { ...rec, expiresAt: now + LEASE_TTL_MS };
        await this.state.storage.put(key, rec);
        ok = true;
      }
    } else if (op === "release") {
      if (!rec) {
        ok = true; // idempotent: releasing an already-free lease is success
      } else if (rec.deviceId === deviceId) {
        await this.state.storage.delete(key);
        rec = null; ok = true;
        // Tell the account's OTHER devices the session freed up immediately.
        this.broadcastLeaseEvent(ws, { kind: "released", sessionId, device: att.device });
      }
      // A non-holder release leaves ok:false with the real holder reported.
    } else if (op === "takeover") {
      // Relay a takeover REQUEST to the account's other devices; the holder
      // answers by releasing (spec §3 step 4). The DO doesn't move the lease.
      ok = true;
      this.broadcastLeaseEvent(ws, { kind: "takeover-request", sessionId, from: { deviceId, device: att.device } });
    } else if (op === "force-acquire") {
      // Spec §3 step 5: holder is unresponsive and the user confirmed a steal.
      // Overwrite unconditionally and notify the (possibly dead) prior holder.
      rec = { deviceId, device: att.device, expiresAt: now + LEASE_TTL_MS };
      await this.state.storage.put(key, rec);
      ok = true;
      this.broadcastLeaseEvent(ws, { kind: "taken", sessionId, device: att.device });
    } else {
      return; // unknown op: drop, never reply
    }

    this.safeSend(ws, JSON.stringify({
      type: "lease-result", reqId: reqId ?? null, op, sessionId, ok,
      holder: rec ? { deviceId: rec.deviceId, device: rec.device, expiresAt: rec.expiresAt } : null,
    }));
  }

  // DO-generated notification — deliberately NOT relaySignal and NOT ring-stored:
  // a replayed stale lease frame would lie about current lease state, so lease
  // events must never enter the replay ring.
  private broadcastLeaseEvent(sender: WebSocket, payload: Record<string, unknown>): void {
    const frame = JSON.stringify({ type: "lease-event", ...payload });
    for (const sock of this.state.getWebSockets()) {
      if (sock === sender) continue;
      this.safeSend(sock, frame);
    }
  }
}
