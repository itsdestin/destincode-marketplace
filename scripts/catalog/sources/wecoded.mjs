// Our own registry (index.json = sync.js output: 13 YouCoded plugins + the
// Anthropic official list). Emits the bundle rows AND one row per member
// (skill / specialist / connection) so the type tabs and search can show them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { github, githubRaw } from "../lib/http.mjs";
import { makeEntry } from "../lib/entry.mjs";
import { scanFiles, addsLine, mcpCapabilities, hooksCapability, skipKey, SCAN_RULES_VERSION } from "../lib/capabilities.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OFFICIAL = "anthropics/claude-plugins-official";
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1)$/i;
const MAX_FILES = 20, MAX_BYTES = 64 * 1024;

/** owner/repo out of any github.com address.
 *
 *  WHY the name may not stop at a dot: `build-with-wordpress` clones
 *  https://github.com/Automattic/claude-code-wordpress.com.git — cutting at the first dot
 *  asked GitHub about "claude-code-wordpress", which does not exist, so that plugin got no
 *  HEAD, no stars and no licence (measured 2026-08-30). Only a trailing ".git" is dropped. */
export function parseRepo(url) {
  const m = String(url ?? "").match(/github\.com\/([^/]+)\/([^/#?]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}

/** Did GitHub actually hand us a file list?
 *
 *  WHY this is its own check: http.mjs turns a 404 into `null`, and treating that as an
 *  empty list means the scanner finds nothing wrong and stamps the plugin "checked" —
 *  a clean bill of health for files nobody read. The same dry run produced exactly that
 *  for build-with-wordpress. A repo that really has no scripts still returns a list
 *  (an empty one), and that one IS honestly checked. */
export const treeIsReadable = (tree) => Array.isArray(tree?.tree);

/** Which of an entry's two urls is actually a GitHub address.
 *
 *  WHY the clone url wins: `repoUrl` in index.json is the vendor's *home page* far
 *  more often than its repository — measured on 2026-08-30, only 130 of the 289 live
 *  non-YouCoded rows have a GitHub `repoUrl`, while 142 point at a marketing site
 *  (honeycomb -> https://www.honeycomb.io) and keep the real repo in `sourceRef`.
 *  Asking GitHub about the marketing site returns nothing, which would leave those 142
 *  entries with no HEAD, no stars and no licence — and the no-HEAD fallback is the
 *  frozen `sourceSha`, the exact stale pin this ingest exists to avoid.
 *  `repoUrl` is still the fallback: the 53 anthropic rows recorded as `sourceType:
 *  "local"` carry a relative `sourceRef` ("./plugins/agent-sdk-dev") and only their
 *  repoUrl names a repository. */
export function githubRepoUrl(entry) {
  for (const url of [entry?.sourceRef, entry?.repoUrl]) if (parseRepo(url)) return url;
  return undefined;
}

/** Files worth scanning for one plugin. Returns { ok, files } — ok=false means
 *  "could not read", which must surface as scan.status 'unchecked'. */
export async function fetchFiles(entry, sha) {
  const wanted = (p) => /^(\.mcp\.json|hooks\/hooks\.json|\.claude-plugin\/plugin\.json)$/.test(p) || (/^(scripts|hooks|bin)\//.test(p) && SCRIPT_EXT.test(p));
  if (entry.sourceType === "local") {
    const dir = path.join(ROOT, entry.sourceRef);
    if (!fs.existsSync(dir)) return { ok: false, files: [] };
    const files = [];
    const walk = (d, rel = "") => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) { if (n !== "node_modules" && n !== ".git") walk(p, r); } else if (wanted(r) && files.length < MAX_FILES) files.push({ path: r, text: fs.readFileSync(p, "utf8").slice(0, MAX_BYTES) }); } };
    walk(dir);
    return { ok: true, files, sha: undefined };
  }
  const gh = parseRepo(githubRepoUrl(entry));
  if (!gh || !sha) return { ok: false, files: [] };
  try {
    const tree = await github(`/repos/${gh.owner}/${gh.repo}/git/trees/${sha}?recursive=1`);
    // Could not read the file list -> "unchecked", never a clean "checked". See treeIsReadable.
    if (!treeIsReadable(tree)) return { ok: false, files: [], error: `no file list for ${gh.owner}/${gh.repo} at ${sha}` };
    const prefix = entry.sourceSubdir ? entry.sourceSubdir.replace(/\/$/, "") + "/" : "";
    const paths = tree.tree.filter((t) => t.type === "blob" && t.path.startsWith(prefix)).map((t) => t.path.slice(prefix.length)).filter(wanted).slice(0, MAX_FILES);
    const files = [];
    for (const p of paths) files.push({ path: p, text: (await githubRaw(gh.owner, gh.repo, sha, prefix + p)).slice(0, MAX_BYTES) });
    return { ok: true, files, sha };
  } catch (e) {
    return { ok: false, files: [], error: String(e.message ?? e) };
  }
}

/** GitHub repo facts, cached per run. */
export function repoFacts() {
  const cache = new Map();
  return async (url) => {
    const gh = parseRepo(url);
    if (!gh) return null;
    const key = `${gh.owner}/${gh.repo}`;
    if (!cache.has(key)) {
      // Two calls per distinct repo per run (facts, then the branch tip) — 207 repos
      // across the 237 live url/git-subdir entries, so ~420 calls at steady state.
      // `head` is the CURRENT tip: the catalog pins to what the author publishes
      // today, never to the stale sourceSha in index.json (see Interfaces).
      cache.set(key, github(`/repos/${key}`)
        .then(async (r) => r ? {
          stars: r.stargazers_count,
          license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined,
          pushedAt: r.pushed_at,
          head: (await github(`/repos/${key}/commits/${r.default_branch}`))?.sha,
        } : null)
        .catch(() => null));
    }
    return cache.get(key);
  };
}

/** Member ids a bundle row implies — needed WITHOUT fetching anything, so a skipped
 *  bundle can report its members as seen too. Mirrors the `member(...)` calls below. */
function memberIds(e) {
  const c = e.components ?? {};
  return [
    ...(c.skills ?? []).map((s) => `${e.id}/${s}`),
    ...(c.agents ?? []).map((a) => `${e.id}/${a}`),
    ...(((c.mcpServers ?? []).length || c.hasMcpConfig) ? [`${e.id}/connection`] : []),
  ];
}

export async function normalise(index, files = fetchFiles, repo = repoFacts(), known = {}) {
  const out = [];
  const skipped = [];
  for (const e of index) {
    if (e.deprecated || e.type === "prompt") continue;
    const isOurs = e.sourceMarketplace === "youcoded";
    const facts = isOurs ? { license: "MIT" } : (await repo(githubRepoUrl(e))) ?? {};
    // The version we are listing: today's HEAD. NEVER e.sourceSha — see Interfaces.
    const sourceCommit = facts.head ?? (isOurs ? undefined : e.sourceSha);
    // Unchanged since the catalog last looked → do not emit it, do not download anything;
    // report it (and its members) as skipped so the retire step knows it was seen. The
    // Worker never hears about it, so it writes nothing (rule 3).
    // skipKey, not the bare commit: an unmoved repo scanned by an older rule set is not
    // up to date. See Interfaces, "Only re-read what changed".
    if (!!sourceCommit && known[e.id] === skipKey(sourceCommit)) {
      skipped.push(e.id, ...memberIds(e));
      continue;
    }
    const fetched = await files(e, sourceCommit);
    const scanned = fetched.ok ? scanFiles(fetched.files, { title: e.displayName }) : null;
    const caps = [];
    if (scanned) {
      caps.push(...scanned.capabilities);
      const mcp = fetched.files.find((f) => f.path === ".mcp.json"); if (mcp) caps.push(...mcpCapabilities(mcp.text, { title: e.displayName }));
      const hooks = fetched.files.find((f) => f.path === "hooks/hooks.json"); const h = hooks && hooksCapability(hooks.text); if (h) caps.push(h);
    }
    const adds = addsLine(e.components); if (adds) caps.push(adds);
    const scan = scanned
      ? (scanned.findings.length
          ? { status: "caution", checkedAt: new Date().toISOString(), findings: scanned.findings, rules: SCAN_RULES_VERSION }
          : { status: "checked", checkedAt: new Date().toISOString(), rules: SCAN_RULES_VERSION })
      : { status: "unchecked" };
    const base = {
      source: isOurs ? "wecoded" : "anthropic",
      origin: isOurs ? "youcoded" : "verified",
      mirroredFrom: isOurs ? undefined : OFFICIAL,
      license: facts.license, stars: facts.stars, sourceCommit,
      author: e.author, repoUrl: e.repoUrl, tags: e.tags, category: e.category, lifeArea: e.lifeArea, audience: e.audience,
      version: e.version, publishedAt: e.publishedAt,
    };
    out.push(makeEntry({ ...base, id: e.id, itemType: "plugin", displayName: e.displayName, description: e.description, tagline: e.tagline, longDescription: e.longDescription,
      sourceType: e.sourceType, sourceRef: e.sourceRef, sourceSubdir: e.sourceSubdir, sourceSha: e.sourceSha, components: e.components,
      capabilities: caps, scan }));
    const member = (itemType, name, displayName, description) => out.push(makeEntry({ ...base, id: `${e.id}/${name}`, itemType, displayName, description,
      sourceType: e.sourceType, sourceRef: e.sourceRef, sourceSubdir: e.sourceSubdir, pluginName: e.id, partOf: { id: e.id, displayName: e.displayName }, capabilities: [], scan }));
    // Member descriptions are left EMPTY, not filled with "Part of <bundle>."
    // The card already shows a `Part of X` chip, and putting the bundle's name
    // into every member's description makes searching that bundle's name match
    // all of its members: type "superpowers" and you get the bundle plus 14
    // near-identical cards. A blank description is honest and does not pollute
    // the search corpus. Real descriptions come from each SKILL.md's frontmatter
    // in the follow-up below.
    const c = e.components ?? {};
    for (const s of c.skills ?? []) member("skill", s, titleCase(s), "");
    for (const a of c.agents ?? []) member("specialist", a, titleCase(a), "");
    if ((c.mcpServers ?? []).length || c.hasMcpConfig) member("tool", "connection", `${e.displayName} (connection)`, "");
  }
  return { rows: out, skipped };
}

const titleCase = (s) => s.replace(/[-_]/g, " ").replace(/^./, (ch) => ch.toUpperCase());

export async function collect({ log, known = {} }) {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "index.json"), "utf8"));
  log(`index.json: ${index.length} rows`);
  const { rows, skipped } = await normalise(index, fetchFiles, repoFacts(), known);
  const sources = { wecoded: rows.filter((r) => r.sourceMarketplace === "youcoded"), anthropic: rows.filter((r) => r.sourceMarketplace === "anthropic") };
  log(`wecoded ${sources.wecoded.length}, anthropic ${sources.anthropic.length}, skipped ${skipped.length} unchanged`);
  return { entries: rows, sources, skipped };
}
