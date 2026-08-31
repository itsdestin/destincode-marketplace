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

// A bundle with a `.mcp.json` had its server's host counted twice — once by the
// generic file scan (which sees the url in the file's raw text) and once by
// mcpCapabilities (which parses the url). Neither producer can see the other's
// output, so the de-duplication belongs at the single point every source's rows
// pass through. Measured on the live catalog: 29 of 4,156 rows showed a repeated
// "What this can do" line.
test("makeEntry never lists the same capability twice, and keeps first-seen order", () => {
  const e = makeEntry({
    source: "wecoded", id: "x", itemType: "plugin", displayName: "X", origin: "youcoded",
    scan: { status: "unchecked" },
    capabilities: [
      { kind: "shell", label: "Runs commands on your computer" },
      { kind: "network", label: "Connects to the internet", detail: "adobe-creativity.adobe.io" },
      { kind: "network", label: "Connects to the internet", detail: "adobe-creativity.adobe.io" },
      { kind: "network", label: "Connects to the internet", detail: "example.com" },
      { kind: "shell", label: "Runs commands on your computer" },
    ],
  });
  assert.deepEqual(e.catalog.capabilities, [
    { kind: "shell", label: "Runs commands on your computer" },
    { kind: "network", label: "Connects to the internet", detail: "adobe-creativity.adobe.io" },
    { kind: "network", label: "Connects to the internet", detail: "example.com" },
  ]);
  // Same label, different detail, is a DIFFERENT line and must survive.
  const two = makeEntry({ source: "wecoded", id: "y", itemType: "plugin", displayName: "Y", origin: "youcoded", scan: { status: "unchecked" },
    capabilities: [{ kind: "secret", label: "Needs a Y key", detail: "A_TOKEN" }, { kind: "secret", label: "Needs a Y key", detail: "B_TOKEN" }] });
  assert.equal(two.catalog.capabilities.length, 2);
});
