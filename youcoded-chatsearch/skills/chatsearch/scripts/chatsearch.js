/**
 * chatsearch — a read-only CLI over the conversation index the YouCoded desktop
 * app writes to `~/.youcoded/chatsearch/`.
 *
 * WHY this file imports nothing from the app: it ships as a marketplace plugin
 * in a different repository, with a different toolchain, and cannot reach the
 * app's TypeScript. The ON-DISK FILE FORMAT is the entire contract between the
 * producer (the app) and this consumer, and golden tests on both sides pin it:
 *
 *   <home>/.youcoded/chatsearch/<provider>-meta.json
 *     { v, provider, refreshedAt, conversations: { <id>: entry } }
 *   <home>/.youcoded/chatsearch/<provider>-turns.jsonl
 *     one JSON object per line: {"c":<id>,"t":<turn>,"ts":<iso>,"x":<user text>}
 *
 * Zero dependencies — Node standard library only.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
// WHY: write commands (flag/tag/note/close) need a request id — env.uuid lets
// tests inject a deterministic one instead of a real random UUID.
import { randomUUID } from 'node:crypto';

// The app writes one pair of files per provider lane. Adding a lane here is the
// only change needed on this side, because everything else reads the entry's
// own `provider` field.
const PROVIDERS = ['claude', 'native'];

const DEFAULT_LIMIT = 20;
const STALE_MS = 24 * 60 * 60 * 1000;
const MIN_SHORT_ID = 4;

// The single sentence used everywhere a transcript's bytes are gone. Kept in one
// constant so `show`, `--turns`, `--around`, and `--tail` can never drift into
// saying different things about the same situation.
const GONE = 'the transcript no longer exists on this device';
const NO_INDEX = 'no chatsearch index exists on this device — open YouCoded to build it';

// Caps on raw-transcript output. `show --turns` exists to read real bytes, but an
// unbounded range would blow an agent's context; both limits are surfaced in the
// output when they bite, never applied silently.
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_BLOCK_CHARS = 2000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** ms since epoch, or null when the value is not a parseable date. */
function toMs(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** YYYY-MM-DD, or a visibly blank column when the date is missing/unparseable. */
function toDay(v) {
  const ms = toMs(v);
  return ms === null ? '----------' : new Date(ms).toISOString().slice(0, 10);
}

function humanAge(ms) {
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Describe a caught fs error accurately — real errno, real path, no guessing. */
function fsErrorDetail(err) {
  const code = err && err.code ? `${err.code}: ` : '';
  return `${code}${err && err.message ? err.message : String(err)}`;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  // The elision is explicit and counted — a silently clipped transcript would
  // read as a complete one.
  return `${text.slice(0, max)}… (+${text.length - max} more characters)`;
}

// ---------------------------------------------------------------------------
// Index loading
// ---------------------------------------------------------------------------

function indexDir(home) {
  return path.join(home, '.youcoded', 'chatsearch');
}

/**
 * Read every provider's meta file. A provider with no meta file simply is not
 * indexed on this device (a Claude-only user has no `native-meta.json`) — that
 * is not an error and is reported as "not indexed", never as a failure.
 */
async function loadIndex(home) {
  const dir = indexDir(home);
  let dirExists = true;
  try {
    const st = await fsp.stat(dir);
    dirExists = st.isDirectory();
  } catch {
    dirExists = false;
  }

  const providers = [];
  const conversations = [];
  const problems = [];

  if (dirExists) {
    for (const name of PROVIDERS) {
      const metaPath = path.join(dir, `${name}-meta.json`);
      const turnsPath = path.join(dir, `${name}-turns.jsonl`);
      let raw;
      try {
        raw = await fsp.readFile(metaPath, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          providers.push({ name, metaPath, turnsPath, present: false, meta: null, count: 0 });
        } else {
          providers.push({ name, metaPath, turnsPath, present: false, meta: null, count: 0, error: fsErrorDetail(err) });
          problems.push(`could not read ${metaPath} — ${fsErrorDetail(err)}`);
        }
        continue;
      }

      let meta;
      try {
        meta = JSON.parse(raw);
      } catch (err) {
        providers.push({ name, metaPath, turnsPath, present: false, meta: null, count: 0, error: err.message });
        problems.push(`could not parse ${metaPath} — ${err.message}`);
        continue;
      }

      const convMap = isRecord(meta) && isRecord(meta.conversations) ? meta.conversations : {};
      let count = 0;
      for (const [id, entry] of Object.entries(convMap)) {
        if (!isRecord(entry)) continue;
        // The map key is authoritative for the id; `entry.id` is a convenience
        // copy and is only used when the key is somehow absent.
        conversations.push({ ...entry, id: String(entry.id || id), provider: String(entry.provider || name), _lane: name });
        count++;
      }
      providers.push({ name, metaPath, turnsPath, present: true, meta, count });
    }
  }

  return { dir, dirExists, providers, conversations, problems };
}

/** Newest refreshedAt across loaded providers, in ms; null when none is parseable. */
function newestRefresh(index) {
  let newest = null;
  for (const p of index.providers) {
    if (!p.present || !isRecord(p.meta)) continue;
    const ms = toMs(p.meta.refreshedAt);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function stalenessBanner(index, now) {
  // Nothing loaded at all is not a staleness problem — the "nothing is indexed"
  // message says it better, and two overlapping explanations read as confusion.
  if (!index.providers.some((p) => p.present)) return null;
  const newest = newestRefresh(index);
  if (newest === null) {
    // Do not guess why: say only what is known.
    return 'index refresh time is unknown — open YouCoded to refresh';
  }
  const age = now - newest;
  if (age <= STALE_MS) return null;
  return `index last refreshed ${Math.floor(age / 86_400_000)}d ago — open YouCoded to refresh`;
}

// ---------------------------------------------------------------------------
// Turns file (Tier 2) reading
// ---------------------------------------------------------------------------

/**
 * Stream a JSONL file line by line. Returns { ok, error } — a missing file is
 * ok:true with no lines (nothing indexed yet for that lane).
 */
async function forEachLine(filePath, onLine) {
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true };
    return { ok: false, error: fsErrorDetail(err) };
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) onLine(line);
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true };
    return { ok: false, error: fsErrorDetail(err) };
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Inverse of the app's `encodeTurnLine`. Returns null for anything malformed —
 * a torn final line (the app appends without an fsync barrier) must be skipped,
 * never crash a search.
 */
function decodeTurn(line) {
  if (!line || !line.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (typeof raw.c !== 'string' || typeof raw.t !== 'number') return null;
  if (typeof raw.ts !== 'string' || typeof raw.x !== 'string') return null;
  return { c: raw.c, t: raw.t, ts: raw.ts, x: raw.x };
}

/** Ids of conversations with at least one user turn containing `needle`. */
async function idsMatchingQuery(index, needle) {
  const lower = needle.toLowerCase();
  const hits = new Set();
  const problems = [];
  for (const p of index.providers) {
    const res = await forEachLine(p.turnsPath, (line) => {
      const turn = decodeTurn(line);
      if (!turn) return;
      if (turn.x.toLowerCase().includes(lower)) hits.add(turn.c);
    });
    if (!res.ok) problems.push(`could not read ${p.turnsPath} — ${res.error}`);
  }
  return { hits, problems };
}

/** The lowest-numbered indexed user turn for a conversation, or null. */
async function firstTurnFor(index, lane, id) {
  let best = null;
  const p = index.providers.find((x) => x.name === lane);
  if (!p) return null;
  await forEachLine(p.turnsPath, (line) => {
    const turn = decodeTurn(line);
    if (!turn || turn.c !== id) return;
    if (best === null || turn.t < best.t) best = turn;
  });
  return best;
}

/** Total decodable turn lines per provider — used by `status`. */
async function countTurns(provider) {
  let n = 0;
  const res = await forEachLine(provider.turnsPath, (line) => {
    if (decodeTurn(line)) n++;
  });
  return { count: n, ok: res.ok, error: res.error };
}

// ---------------------------------------------------------------------------
// Classification and formatting
// ---------------------------------------------------------------------------

/**
 * Three-way state, from what the v1 format actually carries.
 *
 * `complete` is a user-set flag resolved by the app at write time. There is no
 * digest in format v1, so `open` is currently only reachable through the
 * forward-compatible `digest.items[].status` read below — deliberately: calling
 * every un-flagged conversation "open" would assert something the file never
 * said. Per the design spec's legend: ✓ = complete flag or all items resolved,
 * ○ = has open items, ? = no flag and no digest.
 */
function stateOf(entry) {
  if (entry.complete === true) return 'resolved';
  const items = isRecord(entry.digest) && Array.isArray(entry.digest.items) ? entry.digest.items : null;
  if (items && items.length) {
    if (items.some((i) => isRecord(i) && (i.status === 'open' || i.status === 'abandoned'))) return 'open';
    if (items.every((i) => isRecord(i) && i.status === 'resolved')) return 'resolved';
  }
  return 'unknown';
}

/**
 * True once at least one conversation in the index actually carries digest
 * data (an AI-generated summary with per-item status). Format v1 never writes
 * `digest`, so on every device today this is false — which is exactly the
 * fact `find --state open` needs to detect and say plainly, rather than
 * quietly matching zero conversations and reading as "you have no open work".
 */
function indexHasDigestData(index) {
  return index.conversations.some((e) => {
    const items = isRecord(e.digest) && Array.isArray(e.digest.items) ? e.digest.items : null;
    return items !== null && items.length > 0;
  });
}

function markerOf(entry) {
  const base = { resolved: '✓', open: '○', unknown: '?' }[stateOf(entry)];
  // † is appended, not substituted: a dead pointer must never read as a live one.
  return entry.tombstone === true ? `${base}†` : base;
}

/**
 * Map every id to its shortest unambiguous prefix (>= 4 chars), computed across
 * the WHOLE index rather than the result set, so a short id printed by `find`
 * always resolves in `show` even after the filters change.
 */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function shortIdMap(conversations) {
  // Sorted neighbours carry the longest common prefix any other id can have, so
  // one sort answers it for every id. The obvious nested scan is O(n²) and a
  // heavy user's index runs to thousands of conversations.
  const ids = [...new Set(conversations.map((c) => c.id))].sort();
  const map = new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const before = i > 0 ? commonPrefixLen(id, ids[i - 1]) : 0;
    const after = i < ids.length - 1 ? commonPrefixLen(id, ids[i + 1]) : 0;
    const need = Math.max(before, after) + 1;
    map.set(id, id.slice(0, Math.max(MIN_SHORT_ID, need)));
  }
  return map;
}

function formatRows(entries, shorts) {
  const cells = entries.map((e) => ({
    id: shorts.get(e.id) || e.id,
    day: toDay(e.lastActive),
    project: typeof e.projectName === 'string' && e.projectName ? e.projectName : '(no project)',
    marker: markerOf(e),
    title: typeof e.title === 'string' && e.title ? e.title : '(untitled)',
    tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string' && t).map((t) => `#${t}`).join(' ') : '',
  }));
  const w = (key) => cells.reduce((m, c) => Math.max(m, c[key].length), 0);
  const wId = w('id');
  const wProject = w('project');
  const wMarker = w('marker');
  const wTitle = w('title');
  return cells.map((c) =>
    [
      c.id.padEnd(wId),
      c.day,
      c.project.padEnd(wProject),
      c.marker.padEnd(wMarker),
      c.title.padEnd(wTitle),
      c.tags,
    ].join('  ').trimEnd()
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Parse a `since`/`until` value: an absolute date (`2026-07-01`, or any ISO-8601
 * string) or a relative age (`30d`, `12h`, `6w`). Returns { ms } or { error }.
 */
function parseWhen(value, now) {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `expected a date like 2026-07-01 or a relative age like 30d, got ${JSON.stringify(value)}` };
  }
  const v = value.trim();
  const rel = v.match(/^(\d+)\s*([hdw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase()];
    return { ms: now - n * unit };
  }
  const abs = Date.parse(v);
  if (!Number.isNaN(abs)) return { ms: abs };
  return { error: `"${v}" is not a date like 2026-07-01 or a relative age like 30d` };
}

/**
 * `limit` should coerce a numeric string the same way `tail` and `around` do
 * (`Number("50")` is a legitimate value from a JSON-in-a-string caller) — but
 * unlike those two, a genuinely uninterpretable value is reported rather than
 * silently swapped for the default, because a wrong limit changes how much of
 * the result set the agent believes it saw.
 */
function parseLimit(value) {
  if (value === undefined) return { n: DEFAULT_LIMIT };
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return { n };
  return { error: `"${value}" is not a positive whole number` };
}

function normalizePathish(v) {
  return String(v).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** `project` matches the folder basename, the project name, or the full path. */
function matchesProject(entry, wanted) {
  const want = normalizePathish(wanted);
  const candidates = [];
  if (typeof entry.projectName === 'string' && entry.projectName) candidates.push(entry.projectName);
  if (typeof entry.originalPath === 'string' && entry.originalPath) {
    candidates.push(entry.originalPath);
    candidates.push(entry.originalPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '');
  }
  return candidates.some((c) => c && normalizePathish(c) === want);
}

/** Tags are matched by LABEL — the agent never has to know internal tag ids. */
function matchesTags(entry, wanted) {
  const have = new Set(
    (Array.isArray(entry.tags) ? entry.tags : [])
      .filter((t) => typeof t === 'string')
      .map((t) => t.toLowerCase())
  );
  return wanted.every((t) => have.has(String(t).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Transcript reading (show --turns / --around / --tail)
// ---------------------------------------------------------------------------

const INJECTED_PREFIX = '<';

/** The app's "real conversational prompt" gate for the Claude Code lane. */
function ccUserText(parsed) {
  if (!isRecord(parsed)) return null;
  if (parsed.type !== 'user' || parsed.isMeta || !parsed.promptId || !parsed.message) return null;
  const message = parsed.message;
  if (!isRecord(message)) return null;
  const c = message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c
      .filter((b) => isRecord(b) && b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n');
  }
  const t = text.trim();
  // Empty means a tool-result carrier line; '<' means an injected wrapper.
  // Both are excluded from the index, so both must be excluded here or the turn
  // ordinals the CLI computes would not line up with the ones `find` printed.
  if (!t || t.startsWith(INJECTED_PREFIX)) return null;
  return t;
}

/** The same gate for the native harness lane. */
function nativeUserText(parsed) {
  if (!isRecord(parsed) || parsed.type !== 'user-message') return null;
  const data = isRecord(parsed.data) ? parsed.data : null;
  const text = data && typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || text.startsWith(INJECTED_PREFIX)) return null;
  return text;
}

function renderCcEntry(parsed) {
  const role = typeof parsed.type === 'string' ? parsed.type : 'entry';
  const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';
  const parts = [];
  const message = isRecord(parsed.message) ? parsed.message : null;
  const content = message ? message.content : undefined;
  if (typeof content === 'string') {
    parts.push(truncate(content, MAX_BLOCK_CHARS));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') parts.push(truncate(String(block.text ?? ''), MAX_BLOCK_CHARS));
      else if (block.type === 'thinking') parts.push(`[thinking] ${truncate(String(block.thinking ?? ''), MAX_BLOCK_CHARS)}`);
      else if (block.type === 'tool_use') parts.push(`[tool ${String(block.name ?? '?')}] ${truncate(JSON.stringify(block.input ?? null), MAX_BLOCK_CHARS)}`);
      else if (block.type === 'tool_result') parts.push(`[tool result] ${truncate(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null), MAX_BLOCK_CHARS)}`);
      else parts.push(`[${String(block.type ?? 'block')}]`);
    }
  }
  if (!parts.length) parts.push(`[${role} entry with no renderable content]`);
  return { head: `${role}${ts ? `  ${ts}` : ''}`, body: parts };
}

function renderNativeEntry(parsed) {
  const type = typeof parsed.type === 'string' ? parsed.type : 'event';
  const tsRaw = parsed.timestamp;
  const ts = typeof tsRaw === 'number' ? new Date(tsRaw).toISOString() : typeof tsRaw === 'string' ? tsRaw : '';
  const data = isRecord(parsed.data) ? parsed.data : null;
  let body;
  if (data && typeof data.text === 'string') body = [truncate(data.text, MAX_BLOCK_CHARS)];
  else body = [truncate(JSON.stringify(data ?? parsed), MAX_BLOCK_CHARS)];
  return { head: `${type}${ts ? `  ${ts}` : ''}`, body };
}

/**
 * Check whether a transcript's bytes are actually reachable, without reading
 * them. Shared by `readTranscript` (before it parses) and the metadata-only
 * `show` path, so a live (non-tombstoned) entry whose file has since vanished
 * is caught in the SAME call instead of only surfacing when the agent asks
 * for `turns`/`around`/`tail` on a follow-up.
 *
 * Returns { ok: true } or { ok: false, gone: true } / { ok: false, error }.
 */
async function transcriptAccessible(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) {
    return { ok: false, gone: true };
  }
  try {
    await fsp.access(transcriptPath, fs.constants.R_OK);
    return { ok: true };
  } catch (err) {
    // ENOENT is the only case we can honestly call "gone". Anything else gets
    // its real errno surfaced rather than a guess about the cause.
    if (err && err.code === 'ENOENT') return { ok: false, gone: true };
    return { ok: false, error: `could not read the transcript at ${transcriptPath} — ${fsErrorDetail(err)}` };
  }
}

/**
 * Read a transcript and tag each entry with the indexed user-turn ordinal that
 * it belongs to, so `--turns 4-6` yields turn 4's prompt through everything the
 * assistant did before turn 7 — assistant output and tool calls included.
 *
 * `keep` bounds what actually stays in memory. A transcript can run to tens of
 * megabytes (44MB observed in the wild) and the caller only ever wants a
 * narrow slice of it, so every line outside that slice is scanned (its turn
 * still counts toward the true total below) but its parsed content is
 * discarded immediately rather than appended to a growing array:
 *   - { kind: 'range', from, to }: only entries whose turn falls in [from,to]
 *     are retained.
 *   - { kind: 'tail', count }: only the most recent `count` entries are kept,
 *     via a rolling window that evicts the oldest entry as each new one
 *     arrives, so memory tracks the requested tail size, not the file size.
 * Either way the scan still runs to EOF: `lastTurn` (the true total indexed-
 * turn count shown in the heading) is only known once every line is counted,
 * so it cannot be answered without reading the whole file. This changes only
 * what is *retained*, never what the command outputs.
 *
 * Returns { ok: true, entries, lastTurn } or { ok: false, gone: true } / { ok:false, error }.
 */
async function readTranscript(transcriptPath, lane, keep = { kind: 'range', from: 1, to: Infinity }) {
  const access = await transcriptAccessible(transcriptPath);
  if (!access.ok) return access;

  const isTail = keep.kind === 'tail';
  const entries = []; // the kept set for 'range'; the rolling window for 'tail'
  let turn = 0;
  let lineNo = 0;
  let headerSkipped = lane !== 'native'; // native transcripts open with a session header line
  const res = await forEachLine(transcriptPath, (line) => {
    lineNo++;
    if (!line.trim() || line.includes('\x00')) return;
    if (!headerSkipped) {
      headerSkipped = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // a torn or corrupt transcript line is skipped, never fatal
    }
    const userText = lane === 'native' ? nativeUserText(parsed) : ccUserText(parsed);
    if (userText !== null) turn++;

    if (isTail) {
      entries.push({ lineNo, turn, isUserTurn: userText !== null, parsed });
      // Rolling window: once we exceed the requested count, drop the oldest
      // so the array never grows past `count` regardless of file size.
      if (entries.length > keep.count) entries.shift();
    } else if (turn >= keep.from && turn <= keep.to) {
      entries.push({ lineNo, turn, isUserTurn: userText !== null, parsed });
    }
    // A line outside the wanted range is never appended anywhere — `parsed`
    // falls out of scope right here instead of living in an array for the
    // rest of the read, which is the actual memory fix.
  });
  if (!res.ok) {
    return { ok: false, error: `could not read the transcript at ${transcriptPath} — ${res.error}` };
  }
  return { ok: true, entries, lastTurn: turn };
}

function renderTranscriptEntries(entries, lane) {
  const out = [];
  const shown = entries.slice(0, MAX_TRANSCRIPT_ENTRIES);
  for (const e of shown) {
    const r = lane === 'native' ? renderNativeEntry(e.parsed) : renderCcEntry(e.parsed);
    out.push(`[turn ${e.turn}] ${r.head}`);
    for (const part of r.body) {
      for (const line of String(part).split('\n')) out.push(`  ${line}`);
    }
    out.push('');
  }
  if (entries.length > shown.length) {
    out.push(`… stopped after ${MAX_TRANSCRIPT_ENTRIES} transcript entries (${entries.length - shown.length} more in this range) — narrow the range to see the rest`);
  }
  return out;
}

/** Parse `--turns A-B` (also accepts a bare `A`). Returns {from,to} or {error}. */
function parseTurnRange(value) {
  const v = String(value).trim();
  const range = v.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from < 1 || to < from) return { error: `"${v}" is not a turn range — expected A-B with A >= 1 and B >= A` };
    return { from, to };
  }
  const single = v.match(/^(\d+)$/);
  if (single && Number(single[1]) >= 1) return { from: Number(single[1]), to: Number(single[1]) };
  return { error: `"${v}" is not a turn range — expected something like 12-18` };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdFind(req, index, now) {
  const out = [];
  const banner = stalenessBanner(index, now);
  if (banner) out.push(banner);
  out.push(...index.problems);

  let entries = index.conversations;

  if (req.provider) {
    const want = String(req.provider).toLowerCase();
    entries = entries.filter((e) => String(e.provider || '').toLowerCase() === want);
  }
  if (req.project) entries = entries.filter((e) => matchesProject(e, req.project));

  const tags = req.tag === undefined ? [] : Array.isArray(req.tag) ? req.tag : [req.tag];
  if (tags.length) entries = entries.filter((e) => matchesTags(e, tags));

  if (req.state && req.state !== 'any') {
    const want = String(req.state).toLowerCase();
    if (!['resolved', 'open', 'unknown'].includes(want)) {
      return `state "${req.state}" is not one of: resolved, open, unknown, any`;
    }
    // "resolved" and "unknown" are both derivable from the `complete` flag
    // format v1 actually writes — false/absent-with-no-digest is honestly
    // "unknown", not "open". "open" additionally requires per-item digest
    // status; when nothing in the index carries that yet, filtering for it
    // would silently return zero rows, which reads as "you have no open
    // work" when the true answer is "this index can't tell yet".
    if (want === 'open' && !indexHasDigestData(index)) {
      return [
        'state "open" cannot be answered yet on this device.',
        'Resolved/open classification needs conversation summaries (digests), and this index does not carry them — only the "complete" flag from format v1.',
        '"resolved" works today (it reads that flag directly). "open" will start working automatically once YouCoded indexes digests.',
      ].join('\n');
    }
    entries = entries.filter((e) => stateOf(e) === want);
  }

  if (req.since !== undefined) {
    const parsed = parseWhen(req.since, now);
    if (parsed.error) return `since: ${parsed.error}`;
    entries = entries.filter((e) => {
      const ms = toMs(e.lastActive);
      return ms !== null && ms >= parsed.ms;
    });
  }
  if (req.until !== undefined) {
    const parsed = parseWhen(req.until, now);
    if (parsed.error) return `until: ${parsed.error}`;
    entries = entries.filter((e) => {
      const ms = toMs(e.lastActive);
      return ms !== null && ms <= parsed.ms;
    });
  }

  const query = typeof req.query === 'string' ? req.query.trim() : '';
  if (query) {
    const { hits, problems } = await idsMatchingQuery(index, query);
    out.push(...problems);
    entries = entries.filter((e) => hits.has(e.id));
  }

  entries = [...entries].sort((a, b) => (toMs(b.lastActive) ?? 0) - (toMs(a.lastActive) ?? 0));

  const limitResult = parseLimit(req.limit);
  if (limitResult.error) return `limit: ${limitResult.error}`;
  const limit = limitResult.n;
  const total = entries.length;
  const page = entries.slice(0, limit);

  if (!total) {
    const indexed = index.conversations.length;
    // `indexed` counts every metadata row, but a row with turnCount 0 has no
    // indexed turns to search — a tombstone never indexed, a transcript the
    // builder skipped (e.g. a symlink), or one not yet consumed. Reporting
    // `indexed` as "what was searched" would be a fabrication on a device
    // where records synced but transcripts haven't materialized yet: it
    // would claim the search covered conversations whose text was never
    // available. Report the searchable count, and say so explicitly when it
    // differs from the total instead of silently picking one number.
    const searchable = index.conversations.filter((e) => Number.isFinite(e.turnCount) && e.turnCount > 0).length;
    if (indexed === 0) {
      out.push(`nothing is indexed yet in ${index.dir} — open YouCoded to build the index`);
    } else if (searchable === indexed) {
      out.push(`no conversations matched (${indexed} indexed). Try dropping a filter or widening --since.`);
    } else {
      out.push(
        `no conversations matched among the ${searchable} conversation${searchable === 1 ? '' : 's'} with indexed messages ` +
        `(${indexed} conversation${indexed === 1 ? '' : 's'} total, ${indexed - searchable} not yet searchable — no transcript text indexed). ` +
        'Try dropping a filter or widening --since.'
      );
    }
    return out.join('\n');
  }

  const shorts = shortIdMap(index.conversations);
  out.push(...formatRows(page, shorts));
  if (total > page.length) {
    out.push(`showing ${page.length} of ${total} — raise limit or narrow the filters`);
  }
  return out.join('\n');
}

/** Resolve an id or unique prefix. Returns { entry } or { message }. */
function resolveId(index, rawId) {
  const id = String(rawId || '').trim().toLowerCase();
  if (!id) {
    return { message: 'show needs an id — run find first and use the short id from the first column' };
  }
  const exact = index.conversations.filter((e) => e.id.toLowerCase() === id);
  if (exact.length === 1) return { entry: exact[0] };

  const matches = index.conversations.filter((e) => e.id.toLowerCase().startsWith(id));
  if (matches.length === 0) {
    return { message: `no conversation matches id "${rawId}" (${index.conversations.length} indexed). Run find to list what is there.` };
  }
  if (matches.length > 1) {
    const sorted = [...matches].sort((a, b) => (toMs(b.lastActive) ?? 0) - (toMs(a.lastActive) ?? 0));
    const lines = [`id "${rawId}" is ambiguous — ${matches.length} conversations match:`];
    // Listing every candidate would be the context dump this tool exists to
    // avoid; the newest few plus an honest count is enough to disambiguate.
    const shown = sorted.slice(0, 20);
    for (const e of shown) {
      lines.push(`  ${e.id}  ${toDay(e.lastActive)}  ${e.title || '(untitled)'}`);
    }
    if (sorted.length > shown.length) {
      lines.push(`  … and ${sorted.length - shown.length} more — use a longer id prefix`);
    }
    lines.push('Re-run show with one of the full ids above.');
    return { message: lines.join('\n') };
  }
  return { entry: matches[0] };
}

/** Resolve every id up front; one bad id refuses the whole write. */
function resolveIds(index, rawIds, verb) {
  const list = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
  if (!list.length) return { message: `${verb} needs "ids": a list of conversation ids (short ids from find are fine)` };
  const entries = []; const seen = new Set();
  for (const raw of list) {
    const r = resolveId(index, raw);
    if (r.message) return { message: r.message.replace(/\bshow\b/g, verb) };
    if (seen.has(r.entry.id)) continue;
    seen.add(r.entry.id); entries.push(r.entry);
  }
  return { entries };
}

function storeRootOf(index) {
  for (const p of index.providers) if (p.present && p.meta && typeof p.meta.storeRoot === 'string' && p.meta.storeRoot) return p.meta.storeRoot;
  return null;
}
// WHY no version number: the release that carries this is not fixed, and a wrong one is a misleading error.
const NO_STORE_ROOT = 'this index was written by an older YouCoded — update YouCoded, open it once, then retry';

const targetsOf = (entries) => entries.map((e) => ({ provider: e.provider, id: e.id }));

/**
 * Write a request file to the outbox and wait briefly for the app to drop a
 * receipt. The app is not necessarily running, so a timeout is a normal
 * outcome — see the Queued: message below, not an error path.
 */
async function submitRequest(index, ops, env) {
  const storeRoot = storeRootOf(index);
  if (!storeRoot) return { message: NO_STORE_ROOT };
  const id = (env.uuid || randomUUID)();
  const dir = path.join(index.dir, 'outbox');
  await fsp.mkdir(path.join(dir, 'done'), { recursive: true });
  const req = { v: 1, id, createdAt: new Date().toISOString(), storeRoot, ops };
  const target = path.join(dir, `${id}.json`);
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(req, null, 2), 'utf8');
  await fsp.rename(tmp, target);
  const ackPath = path.join(dir, 'done', `${id}.ack.json`);
  const deadline = Date.now() + (typeof env.receiptTimeoutMs === 'number' ? env.receiptTimeoutMs : 2000);
  while (Date.now() < deadline) {
    try { return { receipt: JSON.parse(await fsp.readFile(ackPath, 'utf8')) }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { message: `Queued: YouCoded is not running, or is busy. The change applies the next time it opens (request ${id}).` };
}

function renderReceipt(rc, index) {
  const lines = [];
  if (rc.error) { lines.push(`YouCoded could not use this request: ${rc.error}`); return lines.join('\n'); }
  const titles = new Map(index.conversations.map((e) => [e.id, e.title || '(untitled)']));
  const counts = { applied: 0, already: 0, 'not-found': 0, refused: 0, error: 0 };
  for (const r of rc.results || []) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    lines.push(`  ${r.id}  ${titles.get(r.id) || ''}  ${r.op}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
  }
  for (const t of rc.createdTags || []) lines.push(`  created tag "${t.label}"`);
  lines.push(`applied ${counts.applied} · already ${counts.already} · not found ${counts['not-found']} · refused ${counts.refused} · error ${counts.error}`);
  return lines.join('\n');
}

/** Shared shell for the write commands: resolve ids, build ops, submit, render. */
async function cmdWrite(req, index, now, env, verb, buildOps) {
  const out = [];
  const banner = stalenessBanner(index, now);
  if (banner) out.push(banner);
  out.push(...index.problems);
  const resolved = resolveIds(index, req.ids, verb);
  if (resolved.message) { out.push(resolved.message); return out.join('\n'); }
  const built = buildOps(targetsOf(resolved.entries));
  if (built.message) { out.push(built.message); return out.join('\n'); }
  const sent = await submitRequest(index, built.ops, env);
  out.push(sent.message ? sent.message : renderReceipt(sent.receipt, index));
  return out.join('\n');
}

const cmdFlag = (req, index, now, env) => cmdWrite(req, index, now, env, 'flag', (targets) => {
  if (req.flag !== 'complete' && req.flag !== 'priority') return { message: 'flag needs "flag": "complete" or "priority"' };
  if (typeof req.value !== 'boolean') return { message: 'flag needs "value": true or false' };
  return { ops: [{ op: 'flag', targets, flag: req.flag, value: req.value }] };
});
const cmdTag = (req, index, now, env) => cmdWrite(req, index, now, env, 'tag', (targets) => {
  const strs = (x) => Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
  const add = strs(req.add); const remove = strs(req.remove);
  if (!add.length && !remove.length) return { message: 'tag needs "add" and/or "remove": lists of tag labels' };
  return { ops: [{ op: 'tag', targets, add, remove, create: req.create === true }] };
});
const cmdNote = (req, index, now, env) => cmdWrite(req, index, now, env, 'note', (targets) => {
  if (req.mode !== 'set' && req.mode !== 'append') return { message: 'note needs "mode": "set" or "append"' };
  if (typeof req.text !== 'string') return { message: 'note needs "text"' };
  return { ops: [{ op: 'note', targets, mode: req.mode, text: req.text }] };
});
const cmdClose = (req, index, now, env) => cmdWrite(req, index, now, env, 'close', (targets) => {
  if (typeof req.reason !== 'string' || !req.reason.trim()) return { message: 'close needs "reason": one line on why this conversation is done' };
  return { ops: [{ op: 'flag', targets, flag: 'complete', value: true }, { op: 'note', targets, mode: 'append', text: req.reason.trim() }] };
});
async function cmdReceipt(req, index) {
  const id = String(req.id || '').trim();
  if (!id) return 'receipt needs "id": the request id printed by a Queued write';
  try { return renderReceipt(JSON.parse(await fsp.readFile(path.join(index.dir, 'outbox', 'done', `${id}.ack.json`), 'utf8')), index); }
  // WHY two causes: receipts are deleted after 24 h, so "not applied" alone would be wrong for an old request.
  catch { return `no receipt for request ${id} — either YouCoded has not applied it yet (is it open?), or it applied more than a day ago and the receipt has been cleaned up`; }
}

function metadataBlock(entry) {
  const lines = [];
  lines.push(`${entry.id}  ${entry.title || '(untitled)'}`);
  lines.push(`project:    ${entry.projectName || '(no project)'}${entry.originalPath ? `  (${entry.originalPath})` : ''}`);
  lines.push(`provider:   ${entry.provider || '(unknown)'}`);
  lines.push(`created:    ${entry.createdAt || '(unknown)'}`);
  lines.push(`lastActive: ${entry.lastActive || '(unknown)'}`);
  const flags = [stateOf(entry)];
  if (entry.priority === true) flags.push('priority');
  if (entry.tombstone === true) flags.push('tombstone');
  lines.push(`state:      ${flags.join(', ')}`);
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string' && t) : [];
  lines.push(`tags:       ${tags.length ? tags.join(', ') : '(none)'}`);
  lines.push(`note:       ${entry.note ? entry.note : '(none)'}`);
  const turnCount = Number.isFinite(entry.turnCount) ? entry.turnCount : '?';
  const sizeBytes = Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : '?';
  lines.push(`indexed:    ${turnCount} user turns, ${sizeBytes} bytes of transcript`);
  lines.push(`transcript: ${entry.transcriptPath || '(unknown path)'}`);
  return lines;
}

async function cmdShow(req, index, now) {
  const out = [];
  const banner = stalenessBanner(index, now);
  if (banner) out.push(banner);
  out.push(...index.problems);

  const resolved = resolveId(index, req.id);
  if (resolved.message) {
    out.push(resolved.message);
    return out.join('\n');
  }
  const entry = resolved.entry;
  out.push(...metadataBlock(entry));

  const wantsTranscript = req.turns !== undefined || req.around !== undefined || req.tail !== undefined;

  if (entry.tombstone === true) {
    // The conversation DID happen — only its bytes are gone. Say exactly that,
    // and refuse the raw-transcript flags with the same sentence.
    out.push('');
    out.push(GONE + ' — its metadata is kept so it can still be found and cited.');
    if (wantsTranscript) {
      out.push('the requested transcript excerpt is unavailable for the same reason.');
    }
    const first = await firstTurnFor(index, entry._lane, entry.id);
    if (first) {
      out.push('');
      out.push('first indexed message (from the search index, which outlives the transcript):');
      for (const line of truncate(first.x, MAX_BLOCK_CHARS).split('\n')) out.push(`  ${line}`);
    }
    return out.join('\n');
  }

  if (!wantsTranscript) {
    // Checked here (not just inside readTranscript) so a live entry whose
    // transcript has since disappeared is reported in THIS call — the agent
    // should not have to spend a follow-up `turns`/`around`/`tail` call to
    // discover the same fact.
    const access = await transcriptAccessible(entry.transcriptPath);
    const first = await firstTurnFor(index, entry._lane, entry.id);
    out.push('');
    if (first) {
      out.push('first message:');
      for (const line of truncate(first.x, MAX_BLOCK_CHARS).split('\n')) out.push(`  ${line}`);
    } else {
      out.push('no indexed user turns for this conversation.');
    }
    out.push('');
    if (access.ok) {
      out.push('Read the real transcript with turns "A-B", around N, or tail n.');
    } else if (access.gone) {
      out.push(GONE + ' — turns, around, and tail will not work either.');
    } else {
      out.push(access.error);
    }
    return out.join('\n');
  }

  // Work out which slice of the transcript is wanted BEFORE reading it, so
  // readTranscript can bound what it retains instead of loading every parsed
  // line in the file and throwing most of them away afterward here — that
  // "read it all, filter after" shape is what let a 44MB transcript blow up
  // memory on a `show --tail 20`.
  let mode;
  let rangeFrom, rangeTo, aroundN;
  if (req.turns !== undefined) {
    const range = parseTurnRange(req.turns);
    if (range.error) {
      out.push('');
      out.push(`turns: ${range.error}`);
      return out.join('\n');
    }
    mode = 'turns';
    rangeFrom = range.from;
    rangeTo = range.to;
  } else if (req.around !== undefined) {
    const n = Number(req.around);
    if (!Number.isInteger(n) || n < 1) {
      out.push('');
      out.push(`around: "${req.around}" is not a turn number — expected a whole number >= 1`);
      return out.join('\n');
    }
    const radius = Number.isInteger(req.radius) && req.radius >= 0 ? req.radius : 1;
    mode = 'around';
    aroundN = n;
    rangeFrom = Math.max(1, n - radius);
    rangeTo = n + radius;
  } else {
    mode = 'tail';
  }

  const keep = mode === 'tail'
    ? {
        kind: 'tail',
        // `tail: true` / `tail: null` mean "the default window"; a number or
        // numeric string sets it explicitly. Anything else falls back rather
        // than erroring.
        count: (() => {
          const asked = Number(req.tail);
          return Number.isInteger(asked) && asked > 0 ? asked : 20;
        })(),
      }
    : { kind: 'range', from: rangeFrom, to: rangeTo };

  const transcript = await readTranscript(entry.transcriptPath, entry._lane, keep);
  if (!transcript.ok) {
    out.push('');
    if (transcript.gone) {
      out.push(GONE + ' — the requested transcript excerpt is unavailable.');
    } else {
      out.push(transcript.error);
    }
    return out.join('\n');
  }

  const selected = transcript.entries;
  const heading = mode === 'turns'
    ? `transcript, turns ${rangeFrom}-${rangeTo} (this conversation has ${transcript.lastTurn} indexed turns):`
    : mode === 'around'
      ? `transcript, turns ${rangeFrom}-${rangeTo} around turn ${aroundN} (this conversation has ${transcript.lastTurn} indexed turns):`
      : `transcript, last ${selected.length} entries:`;

  out.push('');
  if (!selected.length) {
    out.push(`no transcript entries in that range (this conversation has ${transcript.lastTurn} indexed turns).`);
    return out.join('\n');
  }
  out.push(heading);
  out.push('');
  out.push(...renderTranscriptEntries(selected, entry._lane));
  return out.join('\n').replace(/\n+$/, '');
}

async function cmdStatus(index, now) {
  const out = [];
  out.push(`chatsearch index: ${index.dir}`);
  if (!index.dirExists) {
    out.push(NO_INDEX);
    return out.join('\n');
  }
  out.push(...index.problems);
  out.push('');
  for (const p of index.providers) {
    if (!p.present) {
      out.push(p.error ? `${p.name}: unreadable — ${p.error}` : `${p.name}: not indexed on this device`);
      continue;
    }
    const refreshed = toMs(p.meta && p.meta.refreshedAt);
    const age = refreshed === null ? 'refresh time unknown' : `refreshed ${humanAge(now - refreshed)}`;
    const turns = await countTurns(p);
    const turnText = turns.ok ? `${turns.count} indexed user turns` : `turns file unreadable — ${turns.error}`;
    const stale = refreshed !== null && now - refreshed > STALE_MS ? '  (stale)' : '';
    out.push(`${p.name}: ${age}, ${p.count} conversation${p.count === 1 ? '' : 's'}, ${turnText}${stale}`);
  }
  const tombstones = index.conversations.filter((e) => e.tombstone === true).length;
  if (tombstones) {
    out.push('');
    out.push(`${tombstones} conversation${tombstones === 1 ? '' : 's'} marked † — metadata kept, transcript no longer on disk.`);
  }
  return out.join('\n');
}

const USAGE = [
  'chatsearch — search your past YouCoded and Claude Code conversations.',
  '',
  'Pass one JSON request object:',
  '  {"cmd":"find","query":"permission timeout","limit":10}',
  '  {"cmd":"find","project":"youcoded","tag":["sync"],"state":"open","since":"30d"}',
  '  {"cmd":"show","id":"a3f2"}',
  '  {"cmd":"show","id":"a3f2","turns":"12-18"}',
  '  {"cmd":"status"}',
  '  {"cmd":"close","ids":["a3f2","9c14"],"reason":"superseded by PR #339"}',
  '  {"cmd":"flag","ids":["a3f2"],"flag":"complete","value":false}',
  '  {"cmd":"tag","ids":["a3f2"],"add":["superseded"],"remove":["wip"],"create":false}',
  '  {"cmd":"note","ids":["a3f2"],"mode":"append","text":"handed off to the Phase D session"}',
  '  {"cmd":"receipt","id":"<request id from a Queued write>"}',
].join('\n');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} req  the request blob: { cmd, query, project, tag, provider,
 *                      state, since, until, limit, id, turns, around, tail }
 * @param {object} env  { home } — injected by tests; defaults to the real home.
 * @returns {Promise<string>} the text to print. Never throws for ordinary
 *                            conditions (missing index, unknown id, dead
 *                            transcript); those are answers, not failures.
 */
export async function runChatsearch(req = {}, env = {}) {
  // env.home is the test-injection seam — keep it checked first so fixtures
  // never touch the real filesystem home. Otherwise defer to os.homedir(),
  // which handles the HOME/USERPROFILE/passwd-entry differences across
  // platforms correctly instead of us re-deriving them by hand.
  let home;
  try {
    home = env.home || os.homedir();
  } catch (err) {
    return `could not determine the home directory — ${fsErrorDetail(err)}`;
  }
  if (!home) {
    return 'could not determine the home directory — os.homedir() returned nothing in this environment';
  }
  const now = typeof env.now === 'number' ? env.now : Date.now();
  const cmd = String(req.cmd || 'find').toLowerCase();

  const index = await loadIndex(home);

  if (cmd === 'status') return cmdStatus(index, now);

  if (!index.dirExists) {
    // The difference between "nothing matched" and "nothing is indexed" decides
    // what the agent tells the user, so it is never collapsed into empty output.
    return `${NO_INDEX}\n(looked in ${index.dir})`;
  }

  if (cmd === 'find') return cmdFind(req, index, now);
  if (cmd === 'show') return cmdShow(req, index, now);
  if (cmd === 'flag') return cmdFlag(req, index, now, env);
  if (cmd === 'tag') return cmdTag(req, index, now, env);
  if (cmd === 'note') return cmdNote(req, index, now, env);
  if (cmd === 'close') return cmdClose(req, index, now, env);
  if (cmd === 'receipt') return cmdReceipt(req, index);
  return `unknown command "${req.cmd}".\n\n${USAGE}`;
}

// --- main-module guard ------------------------------------------------------
// Request comes from argv[2] as JSON, or from stdin when stdin is piped — a
// query can contain quotes, $, and newlines that a shell would mangle.
// Windows-safe module comparison, same as the sibling plugins' scripts.
const _thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(_thisFile) === path.resolve(process.argv[1])) {
  const readStdin = async () => {
    if (process.stdin.isTTY) return '';
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
  };

  (async () => {
    // argv wins when present, and stdin is not touched at all in that case: a
    // caller that leaves stdin open would otherwise hang the process waiting
    // for an EOF that never arrives.
    const fromArgv = (process.argv[2] || '').trim();
    const raw = fromArgv || (await readStdin()).trim() || '{}';
    let req;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      // Show the real parse error and the real input length; do not speculate.
      process.stderr.write(`chatsearch: the request is not valid JSON — ${err.message}\n\n${USAGE}\n`);
      process.exit(1);
      return;
    }
    const out = await runChatsearch(req, {});
    process.stdout.write(`${out}\n`);
  })().catch((err) => {
    process.stderr.write(`chatsearch: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
