---
name: chatsearch
description: Search the user's past YouCoded and Claude Code conversations on this device — what they worked on, when, and whether it got finished. Use when the user half-remembers earlier work ("did we ever finish that sync thing?", "what was that bug from a couple weeks ago?", "what did I decide about X?"), when you need the outcome of a past session, or when the user asks you to look something up in their history. Reads a local index; never leaves the machine.
---

# Chat Search

The YouCoded app keeps a searchable index of the user's past conversations at
`~/.youcoded/chatsearch/`. This skill reads it. It is read-only and entirely
local — nothing is uploaded anywhere.

## When to reach for it

- The user half-remembers past work: *"I vaguely remember working on X — did we
  ever finish it?"*
- The user asks what was decided, tried, or shipped in an earlier session.
- You need context that lives in a conversation, not in the repo.

Do **not** reach for it to answer questions about the current conversation, or
about files you can just read.

## Token discipline — the important part

Transcripts are enormous; a single one can run to tens of megabytes. The whole
point of this tool is to avoid reading them.

1. **Start with `find`.** One row per conversation, ~15 tokens each. Filter hard
   — `project`, `since`, `tag`, `limit` — before you widen.
2. **Then `show` the one conversation that matters.** Metadata plus the opening
   message. Usually this alone answers the question.
3. **Only then read real bytes**, and only a narrow slice: `turns`, `around`, or
   `tail`. Ask for a range you have a reason to want.

**Never dump a whole transcript into your context, and never `show` a whole page
of `find` results one by one.** If `find` returns ten plausible rows, narrow the
query instead of opening all ten.

## Naming past conversations to the user

In YouCoded, `find` and `show` output render as cards with Preview and Resume
buttons, so the user can open whatever you are talking about.

When you name specific past conversations **in your own message**, write them as
a fenced block instead of listing them in prose — YouCoded turns it into the
same card, wherever in the message you put it:

    The permission work is mostly settled; both of these cover it:

    ```conversations
    a3f2
    9c14
    ```

    The newsletter is a separate thread:

    ```conversations
    7a21
    ```

One short id per line, exactly as `find` printed them. Put the block right after
the sentence it belongs to — several small blocks through a message read far
better than one long list at the end. Outside YouCoded it degrades to a short
code block listing the ids, so it is safe to write anywhere.

## How to run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/chatsearch/scripts/chatsearch.js" '{"cmd":"find","query":"permission timeout"}'
```

The request is a single JSON object. **If the query contains quotes, `$`,
backticks, or newlines, pipe the JSON on stdin instead** — the shell will mangle
it otherwise:

```bash
cat <<'JSON' | node "${CLAUDE_PLUGIN_ROOT}/skills/chatsearch/scripts/chatsearch.js"
{"cmd":"find","query":"why did $PATH break"}
JSON
```

Argv wins when both are given.

Claude Code and YouCoded's own harness both fill in `${CLAUDE_PLUGIN_ROOT}`; if it comes through empty, the plugin lives at `~/.claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/`.

## Commands

### `find` — browse and search

| Field | Meaning |
|---|---|
| `query` | Case-insensitive text match against what the **user** typed. Omit it to browse everything, newest first. |
| `project` | Folder basename (`youcoded`) or full path. |
| `tag` | Tag label, or an array of labels (all must match). Labels, not internal ids. |
| `provider` | `claude` or `native`. |
| `state` | `resolved`, `unknown`, or `any` (default). `resolved` reads the app's completion flag and works today. `open` is not usable yet — this device's index has no conversation summaries to derive it from, so the CLI refuses the query with an explanation instead of guessing; don't spend a call finding that out. |
| `since` / `until` | A date (`2026-07-01`) or a relative age (`30d`, `12h`, `6w`). |
| `limit` | Default 20. |

```json
{"cmd":"find","project":"youcoded","tag":["sync"],"since":"30d","limit":10}
```

Output is one row per conversation:

```
a3f2  2026-07-26  youcoded      ✓   Permission ask timeout          #perm #ui
9c14  2026-07-22  youcoded-dev  ?†  Native runtime parity program   #native
```

`<short id>  <date>  <project>  <marker>  <title>  <tags>`

- `✓` marked complete · `○` has open items · `?` no completion signal either way
- **`†` means the transcript file is gone** but the conversation's metadata was
  kept. It happened; only its bytes are missing. Say that, and never imply the
  conversation never took place.
- Ids are shortened to the first unambiguous prefix. Pass a short id straight to
  `show`.

### `show` — one conversation

```json
{"cmd":"show","id":"a3f2"}
```

Prints title, project, dates, state, tags, note, and the opening message. Then,
only if you need the real bytes (assistant output and tool calls included):

| Field | Meaning |
|---|---|
| `turns` | `"12-18"` — that range of user turns and everything between them. |
| `around` | `14` — a window centred on one turn (`radius`, default 1). |
| `tail` | `20` — how the session ended. |

An unknown id says so. An ambiguous prefix lists the candidates rather than
guessing — re-run with one of the full ids it prints.

### `status`

```json
{"cmd":"status"}
```

Per provider: how fresh the index is, how many conversations, how many indexed
user turns.

## Changing things

Five write commands. Each takes `ids` (a list; short ids from `find` are fine)
and writes a request the app applies — the tool itself never edits anything.

| Command | Request |
|---|---|
| `close` | `{"cmd":"close","ids":[…],"reason":"…"}` — mark complete **and** add a dated note line. Prefer this over a bare `flag`. The two are separate ops in one request: if the note would exceed the 8,000-char cap it comes back `refused` while the `complete` flag still comes back `applied` — the conversation ends up marked complete with no note added. Check the note result, not just the summary. |
| `flag` | `{"cmd":"flag","ids":[…],"flag":"complete"\|"priority","value":true\|false}` |
| `tag` | `{"cmd":"tag","ids":[…],"add":["label"],"remove":["label"],"create":false}` — unknown labels are refused unless `"create": true`; say so when you create one. |
| `note` | `{"cmd":"note","ids":[…],"mode":"set"\|"append","text":"…"}` — `set` replaces, `append` adds `<date>: text`. Refused if the result would exceed 8,000 characters. |
| `receipt` | `{"cmd":"receipt","id":"…"}` — fetch the result of a write that came back `Queued`. |

Rules:
- **Show the user the list before any write touching more than five conversations**, and wait for a yes.
- `Queued: YouCoded is not running…` is not a failure. The change lands when the app opens; check with `receipt` if it matters now. **Never re-send a write that came back `Queued`.**
- **The receipt is the confirmation.** The search index catches up a few seconds after a write, so a `find` run right away still shows the old state — do not re-run `find` to check, and do not conclude the write failed.
- One unknown id refuses the whole command before anything is written — fix the id and re-run.
- Every result line says `applied`, `already` (nothing changed), `not-found`, `refused` (with why) or `error`. (The summary line below it spells this one out as "not found" — the per-line token is hyphenated.) Report the summary line to the user verbatim.

## Reading the output honestly

- **Staleness banner.** A first line like `index last refreshed 3d ago — open
  YouCoded to refresh` means the app has not run recently, so anything from the
  last few days may be missing. Pass that on rather than answering as if the
  index were current.
- **`no chatsearch index exists on this device`** is not an empty result. It
  means nothing has been indexed here at all — the user should open YouCoded
  once. Do not report it as "I found nothing about that."
- **No matches** is reported as such, with the number of conversations that were
  actually searchable (have indexed messages) — not the total number of
  metadata rows, which can include tombstones and conversations whose
  transcript hasn't been indexed yet. When those two numbers differ, both are
  shown, e.g. *"no conversations matched among the 40 conversations with
  indexed messages (300 conversations total, 260 not yet searchable)"*. That is
  a real answer: say exactly what was searched, not what merely exists.
- **`state "open" cannot be answered yet on this device`** is not a match count
  of zero. It means the index has no way to tell resolved from open yet, not
  that there is no open work. Never report it as "you have no open items."
