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
// connectedAt/lastActivityAt: liveness seeds — see livenessOf(). Optional so an
// attachment written by the pre-liveness code deserializes without a crash (it
// just reads as maximally stale and gets swept on the next alarm).
interface Attachment { userId: string; card: UserCard; status: Status; connectedAt?: number; lastActivityAt?: number; }

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000; // coarse refresh so a crashed client doesn't freeze last_seen

// LIVENESS MODEL (2026-07-22 stuck-"Online" fix): "online" means "we heard from
// you within PRESENCE_STALE_MS", full stop. A clean close frame just makes the
// user-left announcement prompt; it is no longer the thing presence TRUSTS.
// Close frames are the one signal networks are allowed to lose (laptop sleep,
// Wi-Fi drop, force-kill all skip them), and a ghost socket used to pin an
// account "Online" forever — worse, it swallowed the real socket's later close
// because webSocketClose only announced offline at zero remaining sockets.
//
// 10 min (Destin's call, 2026-07-22): a closed laptop or dead phone reads
// "Last seen …" within ~10-15 min (threshold + up to one 5-min alarm tick)
// instead of pinning "Online". Floor: must stay comfortably above the 30s
// client ping + the 5-min alarm cadence.
// Known, accepted rollout cost at beta scale: Android builds WITHOUT the
// app-level {"type":"ping"} (merged 2026-07-22, unshipped in any APK yet —
// OkHttp's protocol pings are invisible to the DO) get evicted + auto-reconnect
// on a ~10-min loop, briefly flapping offline, until they update. Desktop has
// always sent the app ping and is unaffected. Related: Android Doze defers the
// ping timer on idle phones — a dozing phone reading "away" is treated as
// correct behavior, not a bug (see the archived investigation doc).
const STALE_DEFAULT_MS = 10 * 60 * 1000;

export class PresenceRoom {
  private friendCache = new Map<string, Set<string>>();

  constructor(private state: DurableObjectState, private env: Env) {
    // The edge answers matching pings AND stamps getWebSocketAutoResponseTimestamp
    // without waking the DO — the liveness heartbeat costs zero invocations.
    // The pair must byte-match what clients send: desktop's reconnecting-ws
    // emits JSON.stringify({type:'ping'}) and Android's PresenceClient mirrors
    // it. Non-matching variants still reach webSocketMessage, whose generic
    // lastActivityAt stamp keeps them alive (defense in depth).
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ type: "ping" }), JSON.stringify({ type: "pong" })),
    );
  }

  private staleMs(): number {
    // Env override exists for tests ([env.test.vars]); production omits it.
    const n = Number(this.env.PRESENCE_STALE_MS);
    return Number.isFinite(n) && n > 0 ? n : STALE_DEFAULT_MS;
  }

  /** Most recent proof-of-life for a socket: connect handshake, any real
   *  message, or the edge-stamped auto-response ping — whichever is newest. */
  private livenessOf(sock: WebSocket): number {
    const att = sock.deserializeAttachment() as Attachment | null;
    const auto = this.state.getWebSocketAutoResponseTimestamp(sock);
    return Math.max(att?.connectedAt ?? 0, att?.lastActivityAt ?? 0, auto?.getTime() ?? 0);
  }

  private isLive(sock: WebSocket, now: number): boolean {
    return now - this.livenessOf(sock) <= this.staleMs();
  }

  /** The sockets that count as "online". Every online-semantics decision
   *  (snapshots, wasOnline, challenge reachability, last-socket-left counting)
   *  goes through here so there is exactly one definition of presence. Raw
   *  socketsFor() remains for plain delivery, where a ghost is harmless. */
  private liveSocketsFor(userId: string, now = Date.now()): WebSocket[] {
    return this.socketsFor(userId).filter((s) => this.isLive(s, now));
  }

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

    // LIVE sockets only: a ghost must not make a reconnecting account look
    // "already online" (which would both swallow the user-joined broadcast to
    // friends and inherit a stale status from the dead socket's attachment).
    const existingSockets = this.liveSocketsFor(userId);
    const wasOnline = existingSockets.length > 0;
    // New device inherits the account's live status — multi-device must not
    // downgrade an in-game account to idle just because a second device joined.
    const inheritedStatus: Status = wasOnline
      ? (existingSockets[0]!.deserializeAttachment() as Attachment).status
      : "idle";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server, [userId]); // tag = account id (multi-device: N sockets, one tag)
    server.serializeAttachment({ userId, card, status: inheritedStatus, connectedAt: Date.now() } satisfies Attachment);

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

    // Any real frame proves the peer is alive — stamp it. (Byte-exact pings
    // never reach here — the auto-response pair intercepts and stamps those.)
    ws.serializeAttachment({ ...att, lastActivityAt: Date.now() } satisfies Attachment);

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
        // Live sockets only: relaying into a ghost strands the challenger on
        // the waiting screen forever (nothing will ever answer).
        const conns = this.liveSocketsFor(target);
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
    // LIVE others only: counting a ghost here is what pinned accounts "Online"
    // forever (the real close was swallowed because the ghost kept the count
    // non-zero). If the ghost later turns out alive after all, its next ping
    // makes friends' reconnect-snapshots list the account again — self-healing
    // in both directions.
    const remaining = this.liveSocketsFor(att.userId).filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.writeLastSeen([{ id: att.userId, atSec: Math.floor(Date.now() / 1000) }]);
      await this.broadcastToFriends(att.userId, { type: "user-left", id: att.userId });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // Two jobs on the same ~5-minute tick: refresh last_seen for live accounts
    // (spec §3) and sweep ghost sockets (liveness model, top of file).
    const now = Date.now();
    const live = new Set<string>();
    // userId → newest proof-of-life (ms) among that account's stale sockets.
    const evictedAt = new Map<string, number>();
    for (const sock of this.state.getWebSockets()) {
      const att = sock.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      if (this.isLive(sock, now)) {
        live.add(att.userId);
      } else {
        evictedAt.set(att.userId, Math.max(evictedAt.get(att.userId) ?? 0, this.livenessOf(sock)));
        // 1001 "going away" — an alive-but-silent client (old Android build)
        // treats this like any drop and reconnects on its normal backoff.
        try { sock.close(1001, "stale — no liveness signal"); } catch { /* already closing */ }
      }
    }
    // Eviction that empties an account runs the SAME offline path as a clean
    // close. last_seen gets the ghost's real last proof-of-life, not now() —
    // "Last seen 3d ago" must not reset to "Active just now" on sweep day.
    // (writeLastSeen's MAX guard also keeps a 0-liveness legacy attachment
    // from dragging an existing timestamp backwards.)
    for (const [userId, lastLiveMs] of evictedAt) {
      if (live.has(userId)) continue; // another socket is genuinely alive
      await this.writeLastSeen([{ id: userId, atSec: Math.floor(lastLiveMs / 1000) }]);
      // Friends following deltas never got a user-left for a ghost — send it.
      // A duplicate (if the close path already announced) is a no-op filter
      // client-side, so this stays unconditional and simple.
      await this.broadcastToFriends(userId, { type: "user-left", id: userId });
    }
    if (live.size > 0) {
      const atSec = Math.floor(now / 1000);
      await this.writeLastSeen([...live].map((id) => ({ id, atSec })));
      await this.state.storage.setAlarm(now + LAST_SEEN_REFRESH_MS);
    }
    // No live sockets → no reschedule; the next connect re-arms it.
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
    const now = Date.now();
    for (const fid of friends) {
      // Live sockets only — a ghost must not resurrect a departed friend in
      // every fresh snapshot (that is exactly the restart-doesn't-fix-it half
      // of the stuck-"Online" bug).
      const first = this.liveSocketsFor(fid, now)[0];
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

  private async writeLastSeen(entries: Array<{ id: string; atSec: number }>): Promise<void> {
    if (entries.length === 0) return;
    // MAX guard: the close path and the eviction sweep can both write for the
    // same account (idempotent-by-design), and the sweep's timestamp is the
    // ghost's OLD proof-of-life — last_seen_at must never move backwards.
    await this.env.DB.batch(
      entries.map(({ id, atSec }) =>
        this.env.DB.prepare("UPDATE users SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE id = ?").bind(atSec, id)
      )
    );
  }
}
