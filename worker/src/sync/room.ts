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

    // device is trusted here — it came from the authenticated route's header,
    // not the client's message body (attachment is set in fetch()).
    const att = sender.deserializeAttachment() as Attachment;
    const entry: RingEntry = {
      kind: data.kind,
      spaceKey: data.spaceKey,
      device: att.device,
      at: Date.now(),
    };

    // Append to the replay ring and cap at RING_MAX. Stored in DO storage so it
    // survives hibernation — a device reconnecting after eviction still catches
    // up on recent signals via the hello frame.
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
}
