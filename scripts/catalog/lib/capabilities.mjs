// "What this can do" and the automatic check — computed from FILES, never from
// an author's description (spec §1.6/§1.7). Findings are plain sentences a
// non-technical user can act on; each rule names what it saw.
//
// Bump SCAN_RULES_VERSION on ANY change to the rules in this file — it is half the
// ingest's skip key (`<commit>:<version>`), so bumping it re-scans the whole catalog on
// the next hourly run. Leaving it alone after tightening a rule means the tightening
// never actually runs against anything already listed.
export const SCAN_RULES_VERSION = "1";
export const skipKey = (sha) => `${sha}:${SCAN_RULES_VERSION}`;

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1)$/i;
const HOST_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;
const ENV_KEY_RE = /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY))\b/g;
const HARDCODED_KEY_RE = /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const PIPE_TO_SHELL_RE = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/;
const OBFUSCATION_RE = /\beval\s*\(\s*(Buffer\.from|atob|base64|decode)|base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|\bexec\s*\(\s*atob/;
const RM_RF_RE = /\brm\s+-rf\s+(\/|~|\$HOME)(?![\w/.-]*tmp)/;

export function scanFiles(files, { title }) {
  const capabilities = [];
  const findings = [];
  const hosts = new Set();
  const keys = new Set();
  let shell = false;
  for (const f of files) {
    const text = f.text ?? "";
    if (SCRIPT_EXT.test(f.path)) shell = true;
    for (const m of text.matchAll(HOST_RE)) hosts.add(m[1].toLowerCase());
    for (const m of text.matchAll(ENV_KEY_RE)) keys.add(m[1]);
    if (HARDCODED_KEY_RE.test(text)) findings.push(`Contains what looks like a hard-coded key in ${f.path}`);
    if (PIPE_TO_SHELL_RE.test(text)) findings.push(`Downloads and runs code from the internet (${f.path})`);
    if (OBFUSCATION_RE.test(text)) findings.push(`Runs obfuscated code — text is decoded and executed at runtime (${f.path})`);
    if (RM_RF_RE.test(text)) findings.push(`Deletes files outside its own folder (${f.path})`);
  }
  hosts.delete("github.com"); hosts.delete("raw.githubusercontent.com"); hosts.delete("docs.anthropic.com");
  if (shell) capabilities.push({ kind: "shell", label: "Runs commands on your computer" });
  const hostList = [...hosts].sort();
  if (hostList.length) capabilities.push({ kind: "network", label: "Connects to the internet", detail: hostList.slice(0, 3).join(", ") + (hostList.length > 3 ? ` +${hostList.length - 3}` : "") });
  for (const k of [...keys].sort()) capabilities.push({ kind: "secret", label: `Needs a ${title} key`, detail: k });
  return { capabilities, findings: [...new Set(findings)], hosts: hostList };
}

const EVENT_WORDS = {
  PreToolUse: "before every tool call", PostToolUse: "after every tool call", SessionStart: "when a conversation starts",
  Stop: "every time the assistant stops", SubagentStop: "every time a specialist finishes", UserPromptSubmit: "every time you send a message",
  Notification: "on every notification", PreCompact: "before the conversation is trimmed",
};
export function hooksCapability(text) {
  let json; try { json = JSON.parse(text); } catch { return null; }
  const events = Object.keys(json.hooks ?? json).filter((k) => EVENT_WORDS[k]);
  if (!events.length) return null;
  return { kind: "auto", label: `Runs automatically ${events.map((e) => EVENT_WORDS[e]).join(" and ")}` };
}

export function mcpCapabilities(text, { title }) {
  let json; try { json = JSON.parse(text); } catch { return []; }
  const servers = json.mcpServers ?? json.servers ?? json;
  const caps = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object") continue;
    if (s.command) caps.push({ kind: "shell", label: `Runs ${s.command}${Array.isArray(s.args) && s.args.length ? " " + s.args.slice(0, 2).join(" ") : ""} on your computer` });
    for (const k of Object.keys(s.env ?? {})) caps.push({ kind: "secret", label: `Needs a ${title} key`, detail: k });
    if (typeof s.url === "string") { const h = s.url.match(/^https?:\/\/([^/:]+)/); if (h) caps.push({ kind: "network", label: "Connects to the internet", detail: h[1] }); }
    void name;
  }
  return caps;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export function addsLine(c) {
  if (!c) return null;
  const parts = [];
  if (c.skills?.length) parts.push(plural(c.skills.length, "skill"));
  if (c.commands?.length) parts.push(plural(c.commands.length, "command"));
  if (c.agents?.length) parts.push(plural(c.agents.length, "specialist"));
  if (c.hooks?.length) parts.push(plural(c.hooks.length, "hook"));
  const conns = (c.mcpServers?.length || 0) || (c.hasMcpConfig ? 1 : 0);
  if (conns) parts.push(plural(conns, "connection"));
  if (!parts.length) return null;
  const label = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return { kind: "adds", label: `Adds ${label}` };
}
