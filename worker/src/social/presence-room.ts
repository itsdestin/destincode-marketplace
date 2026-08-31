// Friends-only presence + challenge relay (spec §3). Single global instance
// (idFromName("global")) — same scale class as the PartyKit room it replaces.
//
// Uses the WebSocket HIBERNATION API: per-connection identity lives in the
// socket attachment ({userId, card, status}) and connections are tagged with
// the userId, so both survive DO hibernation. The friend cache is an in-memory
// optimization only — it is reloaded from D1 on demand after a wake-up.
//
// PRIVACY INVARIANT (spec §5): the only PRESENCE fact this class ever persists
// is users.last_seen_at (one timestamp). No presence history, logs, or durations.
// (Games §6.2 added two writes that are NOT presence: settled match rows in
// game_matches, and a short-lived half-report slot in DO storage that is deleted
// the moment the match settles or the attestation window closes.)
import type { Env } from "../types";
import { loadFriendIds, getUserCard, type UserCard } from "./graph";
import {
  isOutcome,
  isValidMatchId,
  isVersusGame,
  reportsAgree,
  type Outcome,
} from "../games/registry";
import { loadRecordVs, matchIsRecorded, recordMatch } from "../games/records";

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

// ---------------------------------------------------------------------------
// Head-to-head attestation (games spec §6.2/§6.3)
// ---------------------------------------------------------------------------
// WHY the result lands here and not on an HTTP route: this DO is the only place
// in the system that holds BOTH players at once, authenticated, keyed by account
// id. PartyKit referees the board but never learns who the players are — it tags
// them by display name, and display names are not unique. So instead of trusting
// the referee, we take one report from each player over their OWN authenticated
// socket and record the match only when the two agree.
//
// A half-report waits in DO storage under this prefix until its partner arrives.
const RESULT_PREFIX = "result:";

// How long a lone report waits for its partner before it is thrown away.
//
// WHY two minutes: both clients learn the game ended from the SAME PartyKit
// broadcast, so the honest gap between the two reports is one network round
// trip. Two minutes is ~100x that — comfortably enough for a client that has to
// re-establish its presence socket first (the desktop socket reconnects on a
// few-seconds backoff) — while staying well under the 10-minute presence
// staleness window, so a half-report can never outlive the session that made it.
// Longer would buy nothing: the slot is keyed by (pair, game, match), so a
// stale half-report can never be paired with a different match anyway.
const RESULT_TIMEOUT_MS = 2 * 60 * 1000;

/** One match awaiting attestation. `reports` maps an account id to what THAT
 *  player says happened to THEM ("win" means that player won). */
interface PendingResult {
  game: string;
  matchId: string;
  reports: Record<string, Outcome>;
  firstReportAt: number; // ms; the clock the RESULT_TIMEOUT_MS window runs on
}

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

  /** Attestation window (games §6.2). Same override pattern as staleMs(): the
   *  2-minute production default is unreachable inside a test run. */
  private resultTimeoutMs(): number {
    const n = Number(this.env.GAME_RESULT_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : RESULT_TIMEOUT_MS;
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
      // Games §6.2: "here is how MY side of that match ended."
      case "game-result":
        await this.handleGameResult(ws, att, data);
        break;
      // Games §6.3: "my opponent left and never came back."
      case "game-forfeit":
        await this.handleGameForfeit(ws, att, data);
        break;
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
    // Three jobs on the same ~5-minute tick: refresh last_seen for live accounts
    // (spec §3), sweep ghost sockets (liveness model, top of file), and drop
    // half-reports whose attestation window closed (games §6.2).
    // A Durable Object has exactly ONE alarm, so anything periodic has to ride
    // this one — do not add a second setAlarm() call anywhere in this class.
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
    const stillPending = await this.sweepPendingResults(now);
    if (live.size > 0) {
      const atSec = Math.floor(now / 1000);
      await this.writeLastSeen([...live].map((id) => ({ id, atSec })));
    }
    // Keep ticking while anyone is online OR a half-report is still waiting —
    // otherwise a slot left behind by two players who both went offline would
    // sit in storage until someone happened to reconnect. (It could never
    // produce a wrong record — the read path expires it lazily too — this is
    // storage hygiene.)
    if (live.size > 0 || stillPending > 0) {
      await this.state.storage.setAlarm(now + LAST_SEEN_REFRESH_MS);
    }
    // Nothing live and nothing pending → no reschedule; the next connect re-arms it.
  }

  // ---- head-to-head attestation (games §6.2/§6.3) ----

  /** Storage key for one match's half-reports. Includes the canonically-ordered
   *  pair so two different pairs that happen to pick the same room code can
   *  never attest into each other's slot. */
  private resultKey(a: string, b: string, game: string, matchId: string): string {
    const [low, high] = a < b ? [a, b] : [b, a];
    return `${RESULT_PREFIX}${low}:${high}:${game}:${matchId}`;
  }

  /** Common validation for both report shapes. Returns the cleaned fields, or
   *  null after telling the caller exactly which part was wrong — a silently
   *  dropped report would show up to the player as a record that just never
   *  appears, with nothing to explain it. */
  private async checkReport(
    ws: WebSocket,
    att: Attachment,
    data: any
  ): Promise<{ game: string; matchId: string; opponent: string } | null> {
    const game = data.game;
    const matchId = data.match_id;
    const opponent = String(data.opponent ?? "");
    const reject = (reason: string) => {
      this.safeSend(
        ws,
        JSON.stringify({ type: "game-result-rejected", game, match_id: matchId, opponent, reason })
      );
      return null;
    };
    if (!isVersusGame(game)) return reject("unknown-game");
    if (!isValidMatchId(matchId)) return reject("invalid-match-id");
    if (!opponent || opponent === att.userId) return reject("invalid-opponent");
    // Records exist only between friends — same rule as the challenge relay, and
    // blocks always sever friendships so this covers blocks too.
    if (!(await this.isFriend(att.userId, opponent))) return reject("not-friends");
    return { game, matchId, opponent };
  }

  private rejectReport(ws: WebSocket, game: string, matchId: string, opponent: string, reason: string): void {
    this.safeSend(
      ws,
      JSON.stringify({ type: "game-result-rejected", game, match_id: matchId, opponent, reason })
    );
  }

  /**
   * One player's account of how a match ended (§6.2).
   *
   * Records the match only when BOTH players have reported and the two reports
   * describe the same match from opposite seats. Disagreement records nothing
   * and is logged. A lone report waits RESULT_TIMEOUT_MS for its partner and is
   * then dropped.
   */
  private async handleGameResult(ws: WebSocket, att: Attachment, data: any): Promise<void> {
    const checked = await this.checkReport(ws, att, data);
    if (!checked) return;
    const { game, matchId, opponent } = checked;
    const outcome = data.outcome;
    if (!isOutcome(outcome)) return this.rejectReport(ws, game, matchId, opponent, "invalid-outcome");

    // IDEMPOTENCY, part 1 — after settlement. The pending slot is deleted when a
    // match is recorded, so without this check a client that retried its report
    // (dropped socket, app restart) would open a FRESH slot for an already-
    // settled match; if the opponent retried too, the pair would attest a second
    // time. The D1 row's primary key would still refuse the duplicate insert,
    // but the client would be told "pending" forever. Answer with the record it
    // already earned instead.
    if (await matchIsRecorded(this.env.DB, att.userId, opponent, game, matchId)) {
      await this.announceRecord(att.userId, opponent, game, matchId, "already-recorded");
      return;
    }

    const key = this.resultKey(att.userId, opponent, game, matchId);
    const now = Date.now();
    let pending = (await this.state.storage.get<PendingResult>(key)) ?? null;
    // Expire lazily as well as on the alarm: the alarm only runs every ~5 min
    // (and not at all once everyone is offline), so the read path must not trust
    // a slot older than the window.
    if (pending && now - pending.firstReportAt > this.resultTimeoutMs()) {
      await this.state.storage.delete(key);
      pending = null;
    }

    // IDEMPOTENCY, part 2 — before settlement. Reports are keyed by account id
    // inside the slot, so a client resending its own report OVERWRITES its
    // previous one. N retries from one player still count as one vote.
    const reports: Record<string, Outcome> = { ...(pending?.reports ?? {}), [att.userId]: outcome };
    const theirs = reports[opponent];
    const firstReportAt = pending?.firstReportAt ?? now;

    if (theirs === undefined) {
      await this.state.storage.put(key, { game, matchId, reports, firstReportAt } satisfies PendingResult);
      this.safeSend(ws, JSON.stringify({ type: "game-result-pending", game, match_id: matchId, opponent }));
      return;
    }

    if (!reportsAgree(outcome, theirs)) {
      // Record NOTHING, log it, tell both players (§6.2: a disagreement is worth
      // logging, not a dispute to adjudicate). The slot is KEPT rather than
      // deleted so a client that corrects itself inside the window can still
      // settle honestly — keeping it cannot make a false record, because the
      // agreement test runs again on every report.
      await this.state.storage.put(key, { game, matchId, reports, firstReportAt } satisfies PendingResult);
      console.warn(
        `game-result disagreement: game=${game} match=${matchId} ${att.userId}=${outcome} ${opponent}=${theirs}`
      );
      const msg = JSON.stringify({ type: "game-result-disputed", game, match_id: matchId });
      for (const sock of [...this.socketsFor(att.userId), ...this.socketsFor(opponent)]) this.safeSend(sock, msg);
      return;
    }

    // Agreed. `outcome` is this reporter's own seat, so "win" means the reporter.
    const winner = outcome === "draw" ? null : outcome === "win" ? att.userId : opponent;
    await recordMatch(this.env.DB, {
      a: att.userId,
      b: opponent,
      game,
      matchId,
      winner,
      source: "attested",
      atSec: Math.floor(now / 1000),
    });
    await this.state.storage.delete(key);
    await this.announceRecord(att.userId, opponent, game, matchId, "attested");
  }

  /**
   * The one case where a SINGLE report stands (§6.3): the opponent left and did
   * not come back, so no second report can ever exist.
   *
   * The guard is that this room independently agrees the other player is gone —
   * liveSocketsFor() is the same definition of "online" every other decision in
   * this class uses, so the claim is checked against state the client cannot
   * touch. If both players dropped, neither is here to claim anything and
   * nothing is recorded, which is exactly what §6.3 asks for.
   */
  private async handleGameForfeit(ws: WebSocket, att: Attachment, data: any): Promise<void> {
    const checked = await this.checkReport(ws, att, data);
    if (!checked) return;
    const { game, matchId, opponent } = checked;

    if (await matchIsRecorded(this.env.DB, att.userId, opponent, game, matchId)) {
      await this.announceRecord(att.userId, opponent, game, matchId, "already-recorded");
      return;
    }

    // The independent check. A client that claims a forfeit while its opponent
    // is still connected is simply told no — it can retry once the reconnect
    // window has genuinely elapsed.
    if (this.liveSocketsFor(opponent).length > 0) {
      return this.rejectReport(ws, game, matchId, opponent, "opponent-still-connected");
    }

    await recordMatch(this.env.DB, {
      a: att.userId,
      b: opponent,
      game,
      matchId,
      winner: att.userId,
      source: "forfeit",
      atSec: Math.floor(Date.now() / 1000),
    });
    // Any half-attestation for this match is now moot.
    await this.state.storage.delete(this.resultKey(att.userId, opponent, game, matchId));
    await this.announceRecord(att.userId, opponent, game, matchId, "forfeit");
  }

  /** Tell both players their (own-perspective) record after a match settles.
   *  The forfeiting player has no live socket by definition, so their copy
   *  simply goes nowhere — they pick the record up from GET /games/records. */
  private async announceRecord(a: string, b: string, game: string, matchId: string, source: string): Promise<void> {
    for (const [me, them] of [[a, b], [b, a]] as const) {
      const record = await loadRecordVs(this.env.DB, me, them, game);
      const msg = JSON.stringify({ type: "game-record", game, match_id: matchId, opponent: them, source, record });
      for (const sock of this.socketsFor(me)) this.safeSend(sock, msg);
    }
  }

  /** Drop half-reports whose window has closed; returns how many are still
   *  waiting (the alarm uses that to decide whether to keep ticking). */
  private async sweepPendingResults(now: number): Promise<number> {
    const entries = await this.state.storage.list<PendingResult>({ prefix: RESULT_PREFIX });
    const stale: string[] = [];
    for (const [key, value] of entries) {
      if (now - value.firstReportAt > this.resultTimeoutMs()) stale.push(key);
    }
    if (stale.length > 0) await this.state.storage.delete(stale);
    return entries.size - stale.length;
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
