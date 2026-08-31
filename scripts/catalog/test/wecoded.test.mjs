import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, githubRepoUrl, parseRepo, treeIsReadable, fetchFiles } from "../sources/wecoded.mjs";
import { skipKey } from "../lib/capabilities.mjs";
import sample from "./fixtures/index-sample.json" with { type: "json" };
import collision from "./fixtures/index-collision-sample.json" with { type: "json" };

test("normalise emits a bundle row + member rows with partOf", async () => {
  const fake = { files: async () => ({ ok: true, files: [{ path: "SKILL.md", text: "hi" }] }), repo: async () => ({ stars: 12, license: "MIT", head: "abc1234" }) };
  const { rows: out } = await normalise(sample, fake.files, fake.repo);
  {
    const bundles = out.filter((r) => r.catalog.itemType === "plugin");
    assert.equal(bundles.length, 3);
    const yc = bundles.find((b) => b.sourceMarketplace === "youcoded");
    assert.equal(yc.catalog.origin.tier, "youcoded");
    const an = bundles.find((b) => b.sourceMarketplace === "anthropic");
    assert.equal(an.catalog.origin.tier, "verified");
    assert.equal(an.catalog.origin.mirroredFrom, "anthropics/claude-plugins-official");
    assert.equal(an.catalog.sourceCommit, "abc1234");   // today's HEAD, not the frozen sourceSha
    const members = out.filter((r) => r.catalog.partOf);
    assert.ok(members.length >= 3);
    const skill = members.find((m) => m.catalog.itemType === "skill");
    assert.match(skill.id, /^[^/]+\/[^/]+$/);
    // A member's description must NOT repeat its bundle's name — that is what
    // makes a search for the bundle also return every one of its members.
    assert.equal(skill.description, "");
    assert.equal(skill.catalog.partOf.id, skill.pluginName);
    assert.ok(members.some((m) => m.catalog.itemType === "specialist"));
    assert.ok(members.some((m) => m.catalog.itemType === "tool"));
    assert.ok(bundles.every((b) => b.catalog.scan.status === "checked"));
    assert.ok(bundles.some((b) => b.catalog.capabilities.some((c) => c.kind === "adds")));
  }
});

test("a failed file fetch leaves the bundle unchecked, never checked", async () => {
  const { rows } = await normalise(sample, async () => ({ ok: false, files: [] }), async () => null);
  assert.ok(rows.filter((r) => !r.catalog.partOf).every((b) => b.catalog.scan.status === "unchecked"));
});

test("pins to today's HEAD, never to the stale sourceSha in index.json", async () => {
  const repo = async () => ({ stars: 1, license: "MIT", head: "newhead1" });
  const { rows } = await normalise(sample, async () => ({ ok: true, files: [] }), repo);
  const external = rows.filter((r) => !r.catalog.partOf && r.sourceMarketplace === "anthropic");
  assert.ok(external.length > 0);
  for (const b of external) {
    assert.equal(b.catalog.sourceCommit, "newhead1");
    assert.notEqual(b.catalog.sourceCommit, b.sourceSha);   // the frozen value must NOT win
  }
});

test("an unchanged entry is not emitted at all — it and its members are reported as skipped", async () => {
  const fetched = [];
  const repo = async () => ({ stars: 1, license: "MIT", head: "samehead" });
  // The Worker's view: every live GitHub-sourced id already at today's HEAD + rule version.
  const external = sample.filter((e) => !e.deprecated && e.sourceMarketplace !== "youcoded");
  const known = Object.fromEntries(external.map((e) => [e.id, skipKey("samehead")]));
  const { rows, skipped } = await normalise(sample, async (e) => { fetched.push(e.id); return { ok: true, files: [] }; }, repo, known);
  // Nothing GitHub-sourced was downloaded or emitted…
  assert.ok(fetched.every((id) => sample.find((e) => e.id === id).sourceMarketplace === "youcoded"));
  assert.ok(rows.every((r) => r.sourceMarketplace === "youcoded"));
  // …and every skipped bundle AND its members are in `skipped`, so finish never retires them.
  for (const e of external) {
    assert.ok(skipped.includes(e.id));
    for (const s of e.components?.skills ?? []) assert.ok(skipped.includes(`${e.id}/${s}`));
  }
  // Our own `local` plugins have no GitHub HEAD to compare, so they are read from the
  // checkout every run — no network, and the Worker's write-skip makes it free.
  assert.ok(fetched.length > 0);
});

// Measured against the live index.json on 2026-08-30: of the 289 live non-youcoded rows,
// only 130 have a repoUrl that is a GitHub address — 142 point at a marketing site
// (https://www.honeycomb.io) while the CLONE url in sourceRef is the real repo. Preferring
// repoUrl would leave those 142 with no HEAD, no stars and no licence, and the code would
// then fall back to the frozen sourceSha — exactly the stale pin this plan forbids.
test("repo facts come from the clone url when the repoUrl is a marketing site", () => {
  assert.equal(
    githubRepoUrl({ sourceRef: "https://github.com/honeycombio/agent-skill.git", repoUrl: "https://www.honeycomb.io" }),
    "https://github.com/honeycombio/agent-skill.git");
  // The 53 anthropic rows recorded as sourceType "local" have a relative sourceRef
  // pointing INTO Anthropic's own repository, so that is where their facts and files
  // come from — including the 17 (the LSP plugins, the messaging ones) whose repoUrl
  // is null and which therefore have no GitHub address of their own at all.
  assert.equal(
    githubRepoUrl({ sourceType: "local", sourceMarketplace: "anthropic", sourceRef: "./plugins/agent-sdk-dev", repoUrl: "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev" }),
    "https://github.com/anthropics/claude-plugins-official");
  assert.equal(
    githubRepoUrl({ sourceType: "local", sourceMarketplace: "anthropic", sourceRef: "./plugins/clangd-lsp", repoUrl: null }),
    "https://github.com/anthropics/claude-plugins-official");
  // OUR own local plugins really are in this checkout and have no GitHub address.
  assert.equal(githubRepoUrl({ sourceType: "local", sourceMarketplace: "youcoded", sourceRef: "apple-services", repoUrl: null }), undefined);
});

// Found by the 2026-08-30 dry run against the live index.json. `build-with-wordpress`
// clones https://github.com/Automattic/claude-code-wordpress.com.git — a repo name that
// contains a dot. Stopping the name at the first dot asked GitHub about a repository that
// does not exist, so the entry got no HEAD, no stars and no licence.
test("a repository name may contain a dot", () => {
  assert.deepEqual(parseRepo("https://github.com/Automattic/claude-code-wordpress.com.git"),
    { owner: "Automattic", repo: "claude-code-wordpress.com" });
  assert.deepEqual(parseRepo("https://github.com/honeycombio/agent-skill.git"),
    { owner: "honeycombio", repo: "agent-skill" });
  assert.deepEqual(parseRepo("https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev"),
    { owner: "anthropics", repo: "claude-plugins-public" });
  assert.equal(parseRepo("https://www.honeycomb.io"), null);
});

// The same dry run turned that missing repository into a scan status of "checked": the
// 404 file list arrives as null, `(tree?.tree ?? [])` made it an empty list, and an empty
// list scans clean. "Never `checked` without having read the files" — so a file list we
// could not read has to be told apart from a repo that simply has no scripts in it.
test("a file list GitHub could not return is 'could not read', never an empty clean read", () => {
  assert.equal(treeIsReadable(null), false);        // http.mjs turns a 404 into null
  assert.equal(treeIsReadable(undefined), false);
  assert.equal(treeIsReadable({}), false);
  assert.equal(treeIsReadable({ tree: [] }), true); // a real repo with nothing worth scanning
});

// ---------------------------------------------------------------------------
// The four bugs found in the catalog's first week (2026-08-31).
// ---------------------------------------------------------------------------

// Bug 1. `claude-security` declares the name "claude-security" under BOTH
// components.skills and components.agents, so the bundle implied two rows sharing
// the id "claude-security/claude-security" — one typed "skill", one "specialist".
// Both went into the same upsert, the last write won, and which one was last
// depended on where the 500-row batch boundary happened to fall, so the listing's
// type flipped between runs. Measured on the live index.json: exactly 1 such
// collision among 2,613 ids from 302 live plugins.
test("a member name declared as both a skill and a specialist emits ONE row", async () => {
  const fake = { files: async () => ({ ok: true, files: [] }), repo: async () => ({ head: "abc1234" }) };
  const { rows } = await normalise(collision, fake.files, fake.repo);
  const dup = rows.filter((r) => r.id === "claude-security/claude-security");
  assert.equal(dup.length, 1, `expected one row, got ${dup.length}: ${dup.map((d) => d.catalog.itemType).join(", ")}`);
  // The first kind declared wins, deterministically — never "whichever was written last".
  assert.equal(dup[0].catalog.itemType, "skill");
  // Every other declared member is still emitted.
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("claude-security/explore"));
  assert.ok(ids.includes("claude-security/patch-generator"));
  assert.equal(new Set(ids).size, ids.length, "the whole batch must have no duplicate ids");
});

test("the skipped-member list matches the rows that would have been emitted", async () => {
  // memberIds() feeds the retire computation; if it and the emitter disagree about
  // the collision, the ingest either retires a live row or keeps a dead one.
  const repo = async () => ({ head: "samehead" });
  const known = { "claude-security": skipKey("samehead") };
  const { rows, skipped } = await normalise(collision, async () => ({ ok: true, files: [] }), repo, known);
  assert.equal(rows.length, 0);
  assert.equal(new Set(skipped).size, skipped.length, `skipped list repeats an id: ${skipped.join(", ")}`);
  assert.ok(skipped.includes("claude-security/claude-security"));
});

// Bug 2. A bundle carrying a `.mcp.json` had the server's host counted twice: the
// generic file scan sees the url in the file's raw TEXT, and mcpCapabilities adds it
// again from the PARSED url. 29 of 4,156 live rows showed the same "What this can do"
// line twice — e.g. adobe-for-creativity's "Connects to the internet ·
// adobe-creativity.adobe.io".
test("a capability line is never listed twice", async () => {
  const mcp = JSON.stringify({ mcpServers: { adobe: { url: "https://adobe-creativity.adobe.io/mcp" } } });
  const files = async () => ({ ok: true, files: [{ path: ".mcp.json", text: mcp }] });
  const { rows } = await normalise(collision, files, async () => ({ head: "abc1234" }));
  const bundle = rows.find((r) => r.catalog.itemType === "plugin");
  const net = bundle.catalog.capabilities.filter((c) => c.kind === "network" && c.detail === "adobe-creativity.adobe.io");
  assert.equal(net.length, 1, `duplicated capability: ${JSON.stringify(bundle.catalog.capabilities)}`);
});

// Bug 4. 53 Anthropic plugins are recorded `sourceType: "local"` with a sourceRef
// like "./plugins/agent-sdk-dev" — a path inside ANTHROPIC's repository, not ours.
// Reading that from our own checkout finds nothing, so all 53 read "Not checked"
// forever. Verified 2026-08-31 against anthropics/claude-plugins-official at
// ed40410: all 53 sourceRef paths exist there as directories.
test("an Anthropic plugin recorded as a local path is read from Anthropic's own repo", async () => {
  const asked = [];
  const github = async (p) => {
    asked.push(p);
    return { tree: [
      { type: "blob", path: "plugins/agent-sdk-dev/.mcp.json" },
      { type: "blob", path: "plugins/agent-sdk-dev/scripts/setup.sh" },
      { type: "blob", path: "plugins/agent-sdk-dev/README.md" },
      { type: "blob", path: "plugins/other-plugin/scripts/not-ours.sh" },
    ] };
  };
  const githubRaw = async (owner, repo, sha, p) => `contents of ${p}`;
  const entry = { id: "agent-sdk-dev", sourceType: "local", sourceRef: "./plugins/agent-sdk-dev",
    sourceMarketplace: "anthropic", repoUrl: "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev" };
  const got = await fetchFiles(entry, "sha0001", { github, githubRaw });
  assert.equal(got.ok, true);
  assert.deepEqual(got.files.map((f) => f.path).sort(), [".mcp.json", "scripts/setup.sh"]);
  assert.match(asked[0] ?? "", /anthropics\/claude-plugins-official/);
});

test("an Anthropic local path missing from the tree stays unchecked, never checked", async () => {
  // The regression this guards: a prefix that matches nothing yields an EMPTY file
  // list, an empty list scans clean, and the plugin gets a clean bill of health for
  // files nobody read.
  const github = async () => ({ tree: [{ type: "blob", path: "plugins/still-here/scripts/a.sh" }] });
  const entry = { id: "gone", sourceType: "local", sourceRef: "./plugins/gone", sourceMarketplace: "anthropic", repoUrl: null };
  const got = await fetchFiles(entry, "sha0001", { github, githubRaw: async () => "" });
  assert.equal(got.ok, false);
  assert.deepEqual(got.files, []);
});

test("our own local plugins are still read from this checkout, never from GitHub", async () => {
  let calledGithub = false;
  const github = async () => { calledGithub = true; return { tree: [] }; };
  const entry = { id: "not-a-real-plugin", sourceType: "local", sourceRef: "not-a-real-plugin", sourceMarketplace: "youcoded", repoUrl: null };
  const got = await fetchFiles(entry, undefined, { github, githubRaw: async () => "" });
  assert.equal(calledGithub, false);
  assert.equal(got.ok, false);   // the folder is not in this checkout → "could not read"
});
