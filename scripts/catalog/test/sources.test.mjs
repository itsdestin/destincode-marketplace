import { test } from "node:test";
import assert from "node:assert/strict";
import docker from "./fixtures/docker-sample.json" with { type: "json" };
import copilot from "./fixtures/copilot-marketplace-sample.json" with { type: "json" };
import fs from "node:fs";
import { normalise as normaliseDocker } from "../sources/docker.mjs";
import { normalise as normaliseCopilot } from "../sources/awesome-copilot.mjs";
import { normalise as normaliseRules } from "../sources/cursorrules.mjs";

test("docker: slug from the map key, verified when Docker built the image, secrets/oauth/hosts → capabilities", () => {
  const [brave] = normaliseDocker(docker);
  assert.equal(brave.id, "docker-brave");
  assert.equal(brave.displayName, "Brave Search");
  assert.equal(brave.catalog.itemType, "tool");
  assert.equal(brave.catalog.origin.tier, "verified");          // image starts with mcp/
  assert.equal(brave.catalog.origin.mirroredFrom, "Docker MCP Catalog");
  assert.equal(brave.catalog.license, "MIT");                    // "MIT License" → SPDX
  assert.equal(brave.catalog.upstreamId, "brave");
  assert.equal(brave.repoUrl, "https://github.com/brave/brave-search-mcp-server");
  assert.match(brave.catalog.sourceCommit, /^[0-9a-f]{7,40}$/);  // from source .../tree/<sha>
  assert.ok(brave.catalog.capabilities.some((c) => c.kind === "secret" && c.detail === "BRAVE_API_KEY"));
  assert.ok(brave.catalog.capabilities.some((c) => c.kind === "network"));
  assert.ok(brave.catalog.capabilities.some((c) => c.kind === "adds" && /tool/.test(c.label)));
  assert.equal(brave.catalog.scan.status, "unchecked");           // no files read here; Docker's provenance is not our scan
  assert.equal(brave.sourceType, "mcp-registry");
});

test("copilot: in-repo plugins pin to the repo sha as git-subdir; external ones resolve their tag", () => {
  const rows = normaliseCopilot(copilot, { repoSha: "deadbeef", resolveRef: () => "cafe1234" });
  const inRepo = rows.find((r) => r.id === "copilot-accessibility-kanban");
  assert.equal(inRepo.sourceType, "git-subdir");
  assert.equal(inRepo.sourceRef, "https://github.com/github/awesome-copilot.git");
  assert.equal(inRepo.sourceSubdir, "plugins/accessibility-kanban");
  assert.equal(inRepo.catalog.sourceCommit, "deadbeef");
  assert.equal(inRepo.catalog.origin.tier, "verified");
  assert.equal(inRepo.catalog.license, "MIT");
  const ext = rows.find((r) => r.id === "copilot-agent-council");
  assert.equal(ext.sourceType, "url");
  assert.equal(ext.sourceRef, "https://github.com/Avyayalaya/agent-council.git");
  assert.equal(ext.catalog.sourceCommit, "cafe1234");
  assert.equal(ext.catalog.origin.tier, "community");
});

test("cursorrules: one prompt row per .mdc, CC0, text inline", () => {
  const text = fs.readFileSync(new URL("./fixtures/cursorrules-sample.mdc", import.meta.url), "utf8");
  const [row] = normaliseRules([{ path: "rules/android-jetpack-compose-cursorrules-prompt-file.mdc", text }], { sha: "88ab01d" });
  assert.equal(row.id, "cursorrules-android-jetpack-compose");
  assert.equal(row.type, "prompt");
  assert.equal(row.catalog.itemType, "prompt");
  assert.equal(row.catalog.license, "CC0-1.0");
  assert.equal(row.version, "88ab01d");   // the commit IS the version — see Task 2; "1.0.0" would never move
  assert.match(row.description, /Jetpack Compose/);
  assert.ok(row.prompt.includes("Jetpack Compose"));
  assert.equal(row.catalog.scan.status, "checked");
  assert.deepEqual(row.catalog.capabilities, []);
});
