// Friends-only presence + challenge relay (spec §3). Single global instance
// (idFromName("global")) — same scale class as the PartyKit room it replaces.
//
// Uses the WebSocket HIBERNATION API: per-connection identity lives in the
// socket attachment ({userId, card, status}) and connections are tagged with
// the userId, so both survive DO hibernation. The friend cache is an in-memory
// optimization only — it is reloaded from D1 on demand after a wake-up.
//
// PRIVACY INVARIANT (spec §5): the ONLY thing this class ever persists is
// users.last_seen_at (one timestamp). No presence history, logs, or durations.
import type { Env } from "../types";
import { loadFriendIds, getUserCard, type UserCard } from "./graph";

type Status = "idle" | "in-game";
interface Attachment { userId: string; card: UserCard; status: Status; }

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000; // coarse refresh so a crashed client doesn't freeze last_seen

export class PresenceRoom {
  private friendCache = new Map<string, Set<string>>();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal poke from friend-mutation routes: refresh caches + re-snapshot.
    if (url.pathname === "/invalidate" && request.method === "POST") {
      const { user_ids } = (await request.json()) as { user_ids: string[] };
      for (const id of user_ids) {
        this.friendCache.delete(id);
        if (this.socketsFor(id).length > 0) {
          await this.sendSnapshot(id);
        }
      }
      return new Response(null, { status: 204 });
    }

    // WebSocket connect — the worker route has already authenticated the
    // session and passes the account id via internal header.
    const userId = request.headers.get("X-Presence-User");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !userId) {
      return new Response("bad request", { status: 400 });
    }
    const card = await getUserCard(this.env.DB, userId);
    if (!card) return new Response("no such user", { status: 404 });

    const existingSockets = this.socketsFor(userId);
    const wasOnline = existingSockets.length > 0;
    // New device inherits the account's live status — multi-device must not
    // downgrade an in-game account to idle just because a second device joined.
    const inheritedStatus: Status = wasOnline
      ? (existingSockets[0]!.deserializeAttachment() as Attachment).status
      : "idle";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server, [userId]); // tag = account id (multi-device: N sockets, one tag)
    server.serializeAttachment({ userId, card, status: inheritedStatus } satisfies Attachment);

    await this.sendSnapshot(userId, server);
    if (!wasOnline) {
      // First connection for this account → tell online friends (spec §3 multi-device rule).
      // inheritedStatus is always "idle" here (!wasOnline) — used for consistency.
      await this.broadcastToFriends(userId, { type: "user-joined", user: { ...card, status: inheritedStatus } });
    }
    // Keep a coarse last_seen alarm running while anyone is connected.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + LAST_SEEN_REFRESH_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    switch (data.type) {
      case "ping":
        this.safeSend(ws, JSON.stringify({ type: "pong" }));
        break;
      case "status": {
        const status: Status = data.status === "in-game" ? "in-game" : "idle";
        // Status is per-account: stamp every connection's attachment so any
        // socket's view is current after hibernation.
        for (const sock of this.socketsFor(att.userId)) {
          const a = sock.deserializeAttachment() as Attachment;
          sock.serializeAttachment({ ...a, status });
        }
        await this.broadcastToFriends(att.userId, { type: "user-status", id: att.userId, status });
        break;
      }
      case "challenge": {
        const target = String(data.target ?? "");
        // Friends-only relay (spec §3). Blocks always sever friendships, so
        // the friendship check also covers blocks (pokes keep the cache fresh).
        if (!(await this.isFriend(att.userId, target))) {
          this.safeSend(ws, JSON.stringify({ type: "challenge-failed", target }));
          break;
        }
        const conns = this.socketsFor(target);
        if (conns.length === 0) {
          this.safeSend(ws, JSON.stringify({ type: "challenge-failed", target }));
          break;
        }
        const msg = JSON.stringify({ type: "challenge", from: att.card, gameType: data.gameType, code: data.code });
        for (const conn of conns) this.safeSend(conn, msg);
        break;
      }
      case "challenge-response": {
        const to = String(data.to ?? "");
        if (!(await this.isFriend(att.userId, to))) break;
        const msg = JSON.stringify({ type: "challenge-response", from: att.card, accept: Boolean(data.accept) });
        for (const conn of this.socketsFor(to)) this.safeSend(conn, msg);
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    // getWebSockets can still include the closing socket — count OTHERS only.
    const remaining = this.socketsFor(att.userId).filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.writeLastSeen([att.userId]);
      await this.broadcastToFriends(att.userId, { type: "user-left", id: att.userId });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // Coarse ~5-minute last_seen refresh for everyone connected (spec §3).
    const online = new Set<string>();
    for (const sock of this.state.getWebSockets()) {
      const att = sock.deserializeAttachment() as Attachment | null;
      if (att) online.add(att.userId);
    }
    if (online.size > 0) {
      await this.writeLastSeen([...online]);
      await this.state.storage.setAlarm(Date.now() + LAST_SEEN_REFRESH_MS);
    }
    // No sockets → no reschedule; the next connect re-arms it.
  }

  // ---- internals ----

  private socketsFor(userId: string): WebSocket[] {
    return this.state.getWebSockets(userId);
  }

  /** send() can throw if the peer is mid-close; one bad socket must never
   *  strand the rest of the loop (same pitfall as transcript readNewLines). */
  private safeSend(sock: WebSocket, msg: string): void {
    try { sock.send(msg); } catch { /* peer closing */ }
  }

  private async friendsOf(userId: string): Promise<Set<string>> {
    let cached = this.friendCache.get(userId);
    if (!cached) {
      cached = new Set(await loadFriendIds(this.env.DB, userId));
      this.friendCache.set(userId, cached);
    }
    return cached;
  }

  private async isFriend(a: string, b: string): Promise<boolean> {
    return (await this.friendsOf(a)).has(b);
  }

  /** Full online-friends snapshot to one user (all their sockets, or one specific socket). */
  private async sendSnapshot(userId: string, only?: WebSocket): Promise<void> {
    const friends = await this.friendsOf(userId);
    const users: Array<UserCard & { status: Status }> = [];
    // No per-fid dedup needed: `friends` is a Set, so each id appears once.
    for (const fid of friends) {
      const first = this.socketsFor(fid)[0];
      if (!first) continue; // friend not online
      const att = first.deserializeAttachment() as Attachment;
      users.push({ ...att.card, status: att.status });
    }
    const msg = JSON.stringify({ type: "presence", users });
    for (const sock of only ? [only] : this.socketsFor(userId)) this.safeSend(sock, msg);
  }

  /** Send an event to every ONLINE friend of userId (never to strangers). */
  private async broadcastToFriends(userId: string, event: Record<string, unknown>): Promise<void> {
    const friends = await this.friendsOf(userId);
    const msg = JSON.stringify(event);
    for (const fid of friends) {
      for (const sock of this.socketsFor(fid)) this.safeSend(sock, msg);
    }
  }

  private async writeLastSeen(userIds: string[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.env.DB.batch(
      userIds.map((id) => this.env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, id))
    );
  }
}
