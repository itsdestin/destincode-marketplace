import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChatsearch } from '../skills/chatsearch/scripts/chatsearch.js';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cli-'));
  const dir = path.join(home, '.youcoded', 'chatsearch');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'claude-meta.json'), JSON.stringify({
    v: 1, provider: 'claude', refreshedAt: new Date().toISOString(),
    conversations: {
      a3f2aaaa: {
        id: 'a3f2aaaa', provider: 'claude', projectName: 'youcoded', originalPath: '/p',
        title: 'Permission ask timeout', lastActive: '2026-07-26T18:04:11.000Z',
        createdAt: '2026-07-26T17:00:00.000Z', complete: true, priority: false,
        tags: ['perm', 'ui'], note: '', transcriptPath: '/tmp/a3f2.jsonl',
        tombstone: false, sizeBytes: 100, turnCount: 2,
        firstTurnTs: '2026-07-26T17:01:00.000Z', lastTurnTs: '2026-07-26T18:04:11.000Z',
      },
      // Quoted because an object key cannot start with a digit unquoted.
      '9c14bbbb': {
        id: '9c14bbbb', provider: 'claude', projectName: 'youcoded-dev', originalPath: '/q',
        title: 'Native runtime parity', lastActive: '2026-07-22T10:00:00.000Z',
        createdAt: '2026-07-22T09:00:00.000Z', complete: false, priority: false,
        tags: ['native'], note: 'superseded', transcriptPath: '/tmp/gone.jsonl',
        tombstone: true, sizeBytes: 0, turnCount: 1,
        firstTurnTs: '2026-07-22T09:30:00.000Z', lastTurnTs: '2026-07-22T09:30:00.000Z',
      },
    },
  }));

  fs.writeFileSync(path.join(dir, 'claude-turns.jsonl'),
    JSON.stringify({ c: 'a3f2aaaa', t: 1, ts: '2026-07-26T17:01:00.000Z', x: 'the permission ask keeps timing out' }) + '\n' +
    JSON.stringify({ c: 'a3f2aaaa', t: 2, ts: '2026-07-26T18:04:11.000Z', x: 'fixed it, merged as 284' }) + '\n' +
    JSON.stringify({ c: '9c14bbbb', t: 1, ts: '2026-07-22T09:30:00.000Z', x: 'native runtime parity program' }) + '\n' +
    '{"torn":' + '\n');

  return home;
}

test('find with no query browses everything, newest first', async () => {
  const out = await runChatsearch({ cmd: 'find' }, { home: fixture() });
  assert.match(out, /a3f2/);
  assert.match(out, /9c14/);
  assert.ok(out.indexOf('a3f2') < out.indexOf('9c14'), 'newest first');
});

test('find matches user turn text case-insensitively', async () => {
  const out = await runChatsearch({ cmd: 'find', query: 'PERMISSION' }, { home: fixture() });
  assert.match(out, /a3f2/);
  assert.doesNotMatch(out, /9c14/);
});

test('a torn final line does not crash the search', async () => {
  const out = await runChatsearch({ cmd: 'find', query: 'parity' }, { home: fixture() });
  assert.match(out, /9c14/);
});

test('status markers: complete, open, tombstone', async () => {
  const out = await runChatsearch({ cmd: 'find' }, { home: fixture() });
  const rows = out.split('\n').filter((l) => /^[0-9a-f]{4}/.test(l));
  assert.match(rows.find((r) => r.startsWith('a3f2')), /✓/);
  // Tombstoned rows carry † so a dead pointer is never mistaken for a live one.
  assert.match(rows.find((r) => r.startsWith('9c14')), /†/);
});

test('--project filters by folder name', async () => {
  const out = await runChatsearch({ cmd: 'find', project: 'youcoded-dev' }, { home: fixture() });
  assert.match(out, /9c14/);
  assert.doesNotMatch(out, /a3f2/);
});

test('--tag filters by label', async () => {
  const out = await runChatsearch({ cmd: 'find', tag: ['native'] }, { home: fixture() });
  assert.match(out, /9c14/);
  assert.doesNotMatch(out, /a3f2/);
});

test('show prints metadata for a short id prefix', async () => {
  const out = await runChatsearch({ cmd: 'show', id: 'a3f2' }, { home: fixture() });
  assert.match(out, /Permission ask timeout/);
  assert.match(out, /youcoded/);
});

test('show on a tombstone says the transcript is gone rather than failing', async () => {
  const out = await runChatsearch({ cmd: 'show', id: '9c14' }, { home: fixture() });
  assert.match(out, /Native runtime parity/);
  assert.match(out, /no longer exists|transcript is gone/i);
});

test('show --turns on a tombstone refuses with the same message', async () => {
  const out = await runChatsearch({ cmd: 'show', id: '9c14', turns: '1-2' }, { home: fixture() });
  assert.match(out, /no longer exists|transcript is gone/i);
});

test('an unknown id says so rather than printing an empty record', async () => {
  const out = await runChatsearch({ cmd: 'show', id: 'ffff' }, { home: fixture() });
  assert.match(out, /no conversation|not found/i);
});

test('an ambiguous id prefix lists the candidates instead of guessing', async () => {
  const home = fixture();
  // Both fixture ids are 8 hex chars; a prefix shared by neither is unambiguous,
  // so add a second conversation sharing 'a3f2' to force the collision.
  const metaPath = path.join(home, '.youcoded', 'chatsearch', 'claude-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.conversations.a3f2cccc = { ...meta.conversations.a3f2aaaa, id: 'a3f2cccc', title: 'Another one' };
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const out = await runChatsearch({ cmd: 'show', id: 'a3f2' }, { home });
  assert.match(out, /ambiguous|matches/i);
  assert.match(out, /a3f2aaaa/);
  assert.match(out, /a3f2cccc/);
});

test('status reports per-provider freshness and counts', async () => {
  const out = await runChatsearch({ cmd: 'status' }, { home: fixture() });
  assert.match(out, /claude/);
  assert.match(out, /2/);
});

test('a stale index prints a banner on find', async () => {
  const home = fixture();
  const metaPath = path.join(home, '.youcoded', 'chatsearch', 'claude-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.refreshedAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const out = await runChatsearch({ cmd: 'find' }, { home });
  assert.match(out, /last refreshed/i);
});

test('a missing index directory says so plainly, not empty results', async () => {
  const out = await runChatsearch({ cmd: 'find' }, { home: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-empty-')) });
  assert.match(out, /no chatsearch index/i);
});

test('find --state open says the index cannot answer, not "no matches"', async () => {
  const out = await runChatsearch({ cmd: 'find', state: 'open' }, { home: fixture() });
  // Must read as "this question is unanswerable", never as a genuine zero-match
  // result — the whole bug was that "no matches" reads as "no open work".
  assert.match(out, /cannot be answered/i);
  assert.doesNotMatch(out, /no conversations matched/i);
});

test('find --state resolved still works from the complete flag', async () => {
  const out = await runChatsearch({ cmd: 'find', state: 'resolved' }, { home: fixture() });
  assert.match(out, /a3f2/);
  assert.doesNotMatch(out, /9c14/);
});

test('limit coerces a numeric string the same way tail and around do', async () => {
  const out = await runChatsearch({ cmd: 'find', limit: '1' }, { home: fixture() });
  const rows = out.split('\n').filter((l) => /^[0-9a-f]{4}/.test(l));
  assert.equal(rows.length, 1);
  assert.match(out, /showing 1 of 2/);
});

test('an uninterpretable limit is reported, not silently replaced with the default', async () => {
  const out = await runChatsearch({ cmd: 'find', limit: 'abc' }, { home: fixture() });
  assert.match(out, /limit/i);
  assert.match(out, /abc/);
});

test('show on a live entry with a missing transcript says so in the same call', async () => {
  const home = fixture();
  const metaPath = path.join(home, '.youcoded', 'chatsearch', 'claude-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  // a3f2aaaa is NOT a tombstone — point its transcript at a path inside this
  // test's own tmp home that is deliberately never created, so ENOENT is
  // guaranteed regardless of what else happens to exist on the host.
  meta.conversations.a3f2aaaa.transcriptPath = path.join(home, 'nonexistent.jsonl');
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const out = await runChatsearch({ cmd: 'show', id: 'a3f2' }, { home });
  assert.match(out, /no longer exists/i);
  // The stale "read more with turns/around/tail" hint must not appear once we
  // already know those calls would just fail the same way.
  assert.doesNotMatch(out, /Read the real transcript/);
});

/**
 * A real (non-tombstoned) transcript with 3 user turns, in the Claude Code
 * lane format `readTranscript`/`ccUserText` expect. Used to pin `turns`,
 * `around`, and `tail` output through the bounded-retention rewrite of
 * `readTranscript` — those flags previously read one already-fully-loaded
 * array; now the array is built incrementally and bounded, so it's worth
 * proving the actual output didn't move.
 */
function transcriptFixture() {
  const home = fixture();
  const transcriptPath = path.join(home, 'a3f2-transcript.jsonl');
  const lines = [
    { type: 'user', promptId: 'p1', message: { content: 'hello turn one' }, timestamp: '2026-07-26T17:01:00.000Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'reply one' }] }, timestamp: '2026-07-26T17:01:05.000Z' },
    { type: 'user', promptId: 'p2', message: { content: 'hello turn two' }, timestamp: '2026-07-26T17:02:00.000Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'reply two' }] }, timestamp: '2026-07-26T17:02:05.000Z' },
    { type: 'user', promptId: 'p3', message: { content: 'hello turn three' }, timestamp: '2026-07-26T17:03:00.000Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'reply three' }] }, timestamp: '2026-07-26T17:03:05.000Z' },
  ];
  fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const metaPath = path.join(home, '.youcoded', 'chatsearch', 'claude-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.conversations.a3f2aaaa.transcriptPath = transcriptPath;
  meta.conversations.a3f2aaaa.turnCount = 3;
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return home;
}

test('show --turns returns only that turn, with the true total turn count', async () => {
  const out = await runChatsearch({ cmd: 'show', id: 'a3f2', turns: '2-2' }, { home: transcriptFixture() });
  assert.match(out, /turns 2-2/);
  assert.match(out, /has 3 indexed turns/);
  assert.match(out, /hello turn two/);
  assert.match(out, /reply two/);
  assert.doesNotMatch(out, /hello turn one/);
  assert.doesNotMatch(out, /hello turn three/);
});

test('show --around centers on the requested turn with the default radius', async () => {
  // n=3, default radius=1 -> range is [max(1, 3-1), 3+1] = [2, 4], clamped by
  // the transcript's actual last turn (3) when rendered.
  const out = await runChatsearch({ cmd: 'show', id: 'a3f2', around: 3 }, { home: transcriptFixture() });
  assert.match(out, /turns 2-4 around turn 3/);
  assert.match(out, /has 3 indexed turns/);
  assert.match(out, /hello turn two/);
  assert.match(out, /hello turn three/);
  assert.doesNotMatch(out, /hello turn one/);
});

test('show --tail returns the last N entries regardless of turn boundaries', async () => {
  const out = await runChatsearch({ cmd: 'show', id: 'a3f2', tail: 2 }, { home: transcriptFixture() });
  assert.match(out, /last 2 entries/);
  assert.match(out, /hello turn three/);
  assert.match(out, /reply three/);
  assert.doesNotMatch(out, /hello turn two/);
});

test('find reports the searchable count, not just the total, when they differ', async () => {
  const home = fixture();
  const metaPath = path.join(home, '.youcoded', 'chatsearch', 'claude-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  // A row with turnCount 0 is not searchable — e.g. a tombstone that was never
  // indexed, a transcript the builder skipped (symlink), or one not yet
  // consumed. It must not be counted as something the search actually covered.
  meta.conversations.deadbeef0 = {
    ...meta.conversations.a3f2aaaa,
    id: 'deadbeef0',
    title: 'Never indexed',
    turnCount: 0,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const out = await runChatsearch({ cmd: 'find', query: 'no such phrase anywhere' }, { home });
  assert.match(out, /no conversations matched/i);
  // 3 metadata rows total, but only 2 have indexed messages — the message
  // must say both numbers, not silently report the misleading total as if
  // every row had been searched.
  assert.match(out, /2 conversations with indexed messages/);
  assert.match(out, /3 conversations total/);
  assert.match(out, /1 not yet searchable/);
});

test('find with an equal searchable/total count keeps the plain message', async () => {
  // No turnCount:0 rows in the base fixture — both numbers are the same, so
  // the message must not grow the "not yet searchable" clause unnecessarily.
  const out = await runChatsearch({ cmd: 'find', query: 'no such phrase anywhere' }, { home: fixture() });
  assert.match(out, /no conversations matched \(2 indexed\)/);
  assert.doesNotMatch(out, /not yet searchable/);
});

test('home directory falls back to os.homedir() when env.home is not injected', async () => {
  const out = await runChatsearch({ cmd: 'status' }, {});
  // Can't assert the exact path (machine-dependent) but this must reach the
  // real status path rather than the old hardcoded HOME/USERPROFILE error.
  assert.match(out, /chatsearch index:/);
});
