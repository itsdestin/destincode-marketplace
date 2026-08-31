import { github, githubRaw } from "../lib/http.mjs";
import { makeEntry, slug } from "../lib/entry.mjs";
import { skipKey, SCAN_RULES_VERSION } from "../lib/capabilities.mjs";
const REPO = "PatrickJS/awesome-cursorrules";

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {}; for (const line of m[1].split("\n")) { const kv = line.match(/^(\w+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].replace(/^"|"$/g, ""); }
  return { meta, body: m[2] };
}

export function normalise(files, { sha }) {
  return files.map(({ path, text }) => {
    const name = path.replace(/^rules\//, "").replace(/\.mdc$/, "").replace(/-cursorrules-prompt-file$/, "");
    const { meta, body } = frontmatter(text);
    return makeEntry({
      source: "cursorrules", id: `cursorrules-${slug(name)}`, itemType: "prompt", displayName: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      // The short commit is the version (Task 2): the app's Update badge compares version
      // strings, and a fixed "1.0.0" would mean an edited rule upstream never shows as one.
      version: sha.slice(0, 7),
      description: meta.description || `Cursor rules: ${name}.`, author: "PatrickJS", repoUrl: `https://github.com/${REPO}/blob/main/${path}`,
      sourceType: "file", sourceRef: `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`, prompt: body.trim().slice(0, 32 * 1024),
      origin: "community", mirroredFrom: "PatrickJS/awesome-cursorrules", license: "CC0-1.0", sourceCommit: sha, upstreamId: path,
      capabilities: [], scan: { status: "checked", checkedAt: new Date().toISOString(), rules: SCAN_RULES_VERSION },   // plain text, no code — read in full above
    });
  });
}

export async function collect({ log, known = {} }) {
  const head = await github(`/repos/${REPO}/commits/HEAD`);
  // 257 files that change roughly never. If the repo tip has not moved since the
  // catalog last read it, download nothing — re-emitting them would be ~257
  // pointless raw fetches an hour. One sample id is enough to tell.
  const mine = Object.keys(known).filter((k) => k.startsWith("cursorrules-"));
  if (mine.length && known[mine[0]] === skipKey(head.sha)) {
    log(`unchanged at ${head.sha.slice(0, 7)} — skipping`);
    // Everything the catalog holds for this source was seen: nothing sent, nothing retired.
    return { entries: [], skipped: mine };
  }
  const tree = (await github(`/repos/${REPO}/git/trees/${head.sha}?recursive=1`))?.tree ?? [];
  const paths = tree.filter((t) => t.type === "blob" && /^rules\/[^/]+\.mdc$/.test(t.path)).map((t) => t.path);
  const files = [];
  for (const p of paths) files.push({ path: p, text: await githubRaw("PatrickJS", "awesome-cursorrules", head.sha, p) });
  const entries = normalise(files, { sha: head.sha });
  log(`${entries.length} rules`);
  return { entries };
}
