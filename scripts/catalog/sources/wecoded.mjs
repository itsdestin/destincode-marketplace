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
  // An Anthropic `local` row's files live in ANTHROPIC's repository, and 17 of the 53
  // name no repository at all, so this is where they get their HEAD, stars and licence.
  // See ANTHROPIC_PLUGINS_REPO below for the evidence that this is the right repo.
  if (anthropicLocalSubdir(entry)) return `https://github.com/${ANTHROPIC_PLUGINS_REPO}`;
  for (const url of [entry?.sourceRef, entry?.repoUrl]) if (parseRepo(url)) return url;
  return undefined;
}

/** Anthropic's plugin monorepo, and the folder inside it an entry points at.
 *
 *  WHY this exists: 53 rows in index.json are recorded `sourceType: "local"` with a
 *  sourceRef like "./plugins/agent-sdk-dev". That path is relative to ANTHROPIC's
 *  repository, not to ours, so reading it out of this checkout finds nothing and all
 *  53 listings said "Not checked" forever — 53 of the 54 unchecked bundles.
 *
 *  WHY the repo name is pinned here rather than read off each row: only 36 of the 53
 *  carry a GitHub repoUrl at all (23 of those spell it "claude-plugins-public", which
 *  GitHub redirects to the same repository); the other 17 — the LSP plugins and the
 *  messaging ones — carry `repoUrl: null`. Checked on 2026-08-31 against
 *  anthropics/claude-plugins-official at commit ed40410: ALL 53 sourceRef paths exist
 *  there as directories, and every one of the 36 repoUrls resolves to that same repo.
 *
 *  A path that is NOT in that repo makes fetchFiles report "could not read", so the
 *  listing stays `unchecked` — never a clean bill of health for files nobody read. */
export const ANTHROPIC_PLUGINS_REPO = OFFICIAL;
export function anthropicLocalSubdir(entry) {
  if (entry?.sourceType !== "local" || entry?.sourceMarketplace !== "anthropic") return null;
  const ref = String(entry?.sourceRef ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!ref || ref.startsWith("/") || ref.split("/").includes("..")) return null;
  return ref;
}

/** Files worth scanning for one plugin. Returns { ok, files } — ok=false means
 *  "could not read", which must surface as scan.status 'unchecked'. */
export async function fetchFiles(entry, sha, deps = {}) {
  // The two network calls are injectable so the tests can drive this without a token
  // or a network; production callers pass nothing and get the real ones.
  const { github: gh = github, githubRaw: raw = githubRaw } = deps;
  const wanted = (p) => /^(\.mcp\.json|hooks\/hooks\.json|\.claude-plugin\/plugin\.json)$/.test(p) || (/^(scripts|hooks|bin)\//.test(p) && SCRIPT_EXT.test(p));
  // An Anthropic `local` row points into Anthropic's repo, not ours — read it from
  // there. Our OWN local plugins (repoUrl: null, sourceMarketplace "youcoded") really
  // do live in this checkout and are still read off disk.
  const anthropicSubdir = anthropicLocalSubdir(entry);
  if (entry.sourceType === "local" && !anthropicSubdir) {
    const dir = path.join(ROOT, entry.sourceRef);
    if (!fs.existsSync(dir)) return { ok: false, files: [] };
    const files = [];
    const walk = (d, rel = "") => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) { if (n !== "node_modules" && n !== ".git") walk(p, r); } else if (wanted(r) && files.length < MAX_FILES) files.push({ path: r, text: fs.readFileSync(p, "utf8").slice(0, MAX_BYTES) }); } };
    walk(dir);
    return { ok: true, files, sha: undefined };
  }
  const repo = parseRepo(githubRepoUrl(entry));
  if (!repo || !sha) return { ok: false, files: [] };
  const prefix = anthropicSubdir ? anthropicSubdir + "/" : (entry.sourceSubdir ? entry.sourceSubdir.replace(/\/$/, "") + "/" : "");
  try {
    const tree = await gh(`/repos/${repo.owner}/${repo.repo}/git/trees/${sha}?recursive=1`);
    // Could not read the file list -> "unchecked", never a clean "checked". See treeIsReadable.
    if (!treeIsReadable(tree)) return { ok: false, files: [], error: `no file list for ${repo.owner}/${repo.repo} at ${sha}` };
    const under = tree.tree.filter((t) => t.path.startsWith(prefix));
    // A subfolder that matches NOTHING in the tree is not "a folder with no scripts in
    // it" — it is a folder we did not find (renamed, moved, or recorded wrong). Passing
    // its empty file list to the scanner would find nothing wrong and stamp a clean bill
    // of health on files nobody read. Same reason treeIsReadable exists.
    if (prefix && !under.length) return { ok: false, files: [], error: `nothing under ${prefix} in ${repo.owner}/${repo.repo} at ${sha}` };
    const paths = under.filter((t) => t.type === "blob").map((t) => t.path.slice(prefix.length)).filter(wanted).slice(0, MAX_FILES);
    const files = [];
    for (const p of paths) files.push({ path: p, text: (await raw(repo.owner, repo.repo, sha, prefix + p)).slice(0, MAX_BYTES) });
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

/** The member rows a bundle implies: one per DISTINCT id, in declaration order
 *  (skills, then specialists, then the connection). Used both to emit the rows and —
 *  without fetching anything — to report a skipped bundle's members as still seen.
 *
 *  WHY the de-duplication: `claude-security` lists the name "claude-security" under
 *  BOTH components.skills and components.agents, so this bundle implied two rows with
 *  the same id, "claude-security/claude-security" — one typed "skill", one
 *  "specialist". Both went into the same upsert, the last one written won, and which
 *  one was last depended on where the 500-row batch boundary happened to fall, so the
 *  listing's type flipped between runs. Measured on the live index.json 2026-08-31:
 *  exactly 1 such collision among the 2,613 ids of the 302 live plugins.
 *
 *  WHY the first kind wins rather than a renamed second row: an id is the only handle
 *  the app has on a listing, and inventing "…/claude-security-specialist" would
 *  fabricate a member this bundle never declares under that name — and could itself
 *  collide with a real one. Dropping the duplicate costs nothing a user can see: the
 *  surviving row carries the same name and the bundle's "Adds 1 skill, 3 specialists
 *  and 1 hook" line still counts every declared member. */
function members(e) {
  const c = e.components ?? {};
  const out = [];
  const seen = new Set();
  const add = (itemType, name, displayName) => {
    const id = `${e.id}/${name}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, itemType, name, displayName });
  };
  for (const s of c.skills ?? []) add("skill", s, titleCase(s));
  for (const a of c.agents ?? []) add("specialist", a, titleCase(a));
  if ((c.mcpServers ?? []).length || c.hasMcpConfig) add("tool", "connection", `${e.displayName} (connection)`);
  return out;
}
const memberIds = (e) => members(e).map((m) => m.id);

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
    // Descriptions are deliberately EMPTY — see the note below.
    for (const m of members(e)) out.push(makeEntry({ ...base, id: m.id, itemType: m.itemType, displayName: m.displayName, description: "",
      sourceType: e.sourceType, sourceRef: e.sourceRef, sourceSubdir: e.sourceSubdir, pluginName: e.id, partOf: { id: e.id, displayName: e.displayName }, capabilities: [], scan }));
    // Member descriptions are left EMPTY, not filled with "Part of <bundle>."
    // The card already shows a `Part of X` chip, and putting the bundle's name
    // into every member's description makes searching that bundle's name match
    // all of its members: type "superpowers" and you get the bundle plus 14
    // near-identical cards. A blank description is honest and does not pollute
    // the search corpus. Real descriptions come from each SKILL.md's frontmatter
    // in the follow-up below.
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
