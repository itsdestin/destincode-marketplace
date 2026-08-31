// github/awesome-copilot, mirrored: its plugin marketplace plus the standalone skills,
// specialists and instruction files that live loose in the repo tree.
// As with docker.mjs, NOTHING here may vary per run — see the note in that file.
import { getJson, github } from "../lib/http.mjs";
import { makeEntry, slug } from "../lib/entry.mjs";
const REPO = "github/awesome-copilot", CLONE = `https://github.com/${REPO}.git`, RAW = `https://raw.githubusercontent.com/${REPO}/main`;

export function normalise(marketplace, { repoSha, resolveRef, tree = [] }) {
  const out = [];
  const common = { source: "awesome-copilot", mirroredFrom: "github/awesome-copilot", scan: { status: "unchecked" }, capabilities: [] };
  for (const p of marketplace.plugins ?? []) {
    if (typeof p.source === "string") {
      out.push(makeEntry({ ...common, id: `copilot-${slug(p.name)}`, itemType: "plugin", displayName: p.name, description: p.description, author: "GitHub",
        repoUrl: `https://github.com/${REPO}/tree/main/${p.source}`, tags: (p.keywords ?? []).slice(0, 6), version: p.version,
        sourceType: "git-subdir", sourceRef: CLONE, sourceSubdir: p.source, origin: "verified", license: "MIT", sourceCommit: repoSha, upstreamId: p.name }));
    } else if (p.source && p.source.source === "github" && p.source.repo) {
      const ref = p.source.ref;
      out.push(makeEntry({ ...common, id: `copilot-${slug(p.name)}`, itemType: "plugin", displayName: p.name, description: p.description, author: p.author?.name ?? p.source.repo.split("/")[0],
        repoUrl: `https://github.com/${p.source.repo}`, tags: (p.keywords ?? []).slice(0, 6), version: p.version,
        sourceType: "url", sourceRef: `https://github.com/${p.source.repo}.git`, origin: "community", license: p.license, sourceCommit: resolveRef(p.source.repo, ref), upstreamId: `${p.source.repo}@${ref ?? "HEAD"}` }));
    }
  }
  // Standalone items in the repo tree: skills, agents (specialists), instructions (prompts).
  for (const t of tree) {
    const m = t.match(/^skills\/([^/]+)\/SKILL\.md$/); if (m) out.push(makeEntry({ ...common, id: `copilot-skill-${slug(m[1])}`, itemType: "skill", displayName: titleCase(m[1]), description: `Skill from github/awesome-copilot: ${m[1]}.`, author: "GitHub", repoUrl: `https://github.com/${REPO}/tree/main/skills/${m[1]}`, sourceType: "git-subdir", sourceRef: CLONE, sourceSubdir: `skills/${m[1]}`, origin: "verified", license: "MIT", sourceCommit: repoSha, upstreamId: `skills/${m[1]}` }));
    const a = t.match(/^agents\/([^/]+)\.agent\.md$/); if (a) out.push(makeEntry({ ...common, id: `copilot-agent-${slug(a[1])}`, itemType: "specialist", displayName: titleCase(a[1]), description: `Specialist from github/awesome-copilot: ${a[1]}.`, author: "GitHub", repoUrl: `https://github.com/${REPO}/blob/main/${t}`, sourceType: "file", sourceRef: `${RAW}/${t}`, origin: "verified", license: "MIT", sourceCommit: repoSha, upstreamId: t }));
    const i = t.match(/^instructions\/([^/]+)\.instructions\.md$/); if (i) out.push(makeEntry({ ...common, id: `copilot-instructions-${slug(i[1])}`, itemType: "prompt", displayName: titleCase(i[1]), description: `Instructions from github/awesome-copilot: ${i[1]}.`, author: "GitHub", repoUrl: `https://github.com/${REPO}/blob/main/${t}`, sourceType: "file", sourceRef: `${RAW}/${t}`, origin: "verified", license: "MIT", sourceCommit: repoSha, upstreamId: t }));
  }
  return out;
}
const titleCase = (s) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function collect({ log }) {
  const marketplace = await getJson(`${RAW}/.github/plugin/marketplace.json`);
  const head = await github(`/repos/${REPO}/commits/HEAD`);
  const tree = (await github(`/repos/${REPO}/git/trees/${head.sha}?recursive=1`))?.tree?.map((t) => t.path) ?? [];
  const refCache = new Map();
  const resolveRef = (repo, ref) => refCache.get(`${repo}@${ref}`);
  // Resolve external refs up front (one call each) so normalise stays pure.
  for (const p of marketplace.plugins ?? []) if (p.source && typeof p.source === "object") {
    const k = `${p.source.repo}@${p.source.ref}`; if (!refCache.has(k)) refCache.set(k, (await github(`/repos/${p.source.repo}/commits/${p.source.ref ?? "HEAD"}`))?.sha);
  }
  const entries = normalise(marketplace, { repoSha: head.sha, resolveRef, tree });
  log(`${entries.length} rows (plugins + skills + specialists + instructions)`);
  return { entries };
}
