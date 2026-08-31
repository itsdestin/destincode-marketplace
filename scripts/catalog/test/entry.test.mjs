import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, licenseToSpdx, makeEntry, destinationsOf, unknownSourceMessage } from "../lib/entry.mjs";

test("slug is installer-safe", () => {
  assert.equal(slug("ai.agenttrust/mcp-server"), "ai-agenttrust-mcp-server");
  assert.equal(slug("  Brave Search!! "), "brave-search");
});

test("licenseToSpdx maps Docker's free-text names and passes SPDX through", () => {
  assert.equal(licenseToSpdx("MIT License"), "MIT");
  assert.equal(licenseToSpdx("Apache License 2.0"), "Apache-2.0");
  assert.equal(licenseToSpdx("MIT"), "MIT");
  assert.equal(licenseToSpdx("NOASSERTION"), undefined);
  assert.equal(licenseToSpdx(null), undefined);
});

test("makeEntry emits the index.json shape plus catalog", () => {
  const e = makeEntry({
    source: "docker",
    id: "docker-brave", itemType: "tool", displayName: "Brave Search", description: "d", author: "brave",
    repoUrl: "https://github.com/brave/brave-search-mcp-server", sourceType: "mcp-registry", sourceRef: "docker:mcp/brave-search",
    origin: "verified", mirroredFrom: "Docker MCP Catalog", license: "MIT", upstreamId: "brave", capabilities: [], scan: { status: "unchecked" },
  });
  assert.equal(e.type, "plugin");
  assert.equal(e.sourceMarketplace, "docker");
  assert.equal(e.catalog.itemType, "tool");
  assert.equal(e.catalog.origin.tier, "verified");
  assert.equal(e.catalog.license, "MIT");
  assert.equal(e.publishedAt, undefined);   // never "today" — the Worker stamps first-seen; a daily-changing value would defeat its write-skip
  assert.equal(e.category, "development");
});

// The collectors build.mjs can actually run. Kept literal here on purpose: if a collector is
// added or renamed, this test is where the rejection message gets re-checked against it.
const COLLECTORS = ["wecoded", "docker", "awesome-copilot", "cursorrules"];

test("a rejected --source never names the value it just rejected", () => {
  // The bug: the message was built from the DESTINATION list, so `--source anthropic` failed
  // with "...known: wecoded, anthropic, ..." — calling the value valid while refusing it.
  const msg = unknownSourceMessage("anthropic", COLLECTORS);
  assert.ok(!/collectors are:[^.]*\banthropic\b/.test(msg), `still lists anthropic as runnable: ${msg}`);
  assert.match(msg, /"anthropic" is a catalog destination, not a collector/);
  assert.match(msg, /produced by the "wecoded" collector, so run --source wecoded/);
});

test("a genuinely unknown --source just names the collectors", () => {
  const msg = unknownSourceMessage("nope", COLLECTORS);
  assert.equal(msg, 'unknown --source "nope"; collectors are: wecoded, docker, awesome-copilot, cursorrules.');
});

test("every collector has at least one destination, and wecoded feeds anthropic", () => {
  // Guards the derivation build.mjs uses to decide where a collector's rows are sent.
  assert.deepEqual(destinationsOf("wecoded"), ["wecoded", "anthropic"]);
  for (const c of COLLECTORS) assert.ok(destinationsOf(c).length > 0, `${c} emits nowhere`);
});
