import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, githubRepoUrl, parseRepo, treeIsReadable } from "../sources/wecoded.mjs";
import { skipKey } from "../lib/capabilities.mjs";
import sample from "./fixtures/index-sample.json" with { type: "json" };

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
  // The 53 anthropic rows recorded as sourceType "local" have a relative sourceRef,
  // so their repoUrl is the only GitHub address available.
  assert.equal(
    githubRepoUrl({ sourceRef: "./plugins/agent-sdk-dev", repoUrl: "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev" }),
    "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev");
  assert.equal(githubRepoUrl({ sourceRef: "./plugins/clangd-lsp", repoUrl: null }), undefined);
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
