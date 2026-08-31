import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, licenseToSpdx, makeEntry } from "../lib/entry.mjs";

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
