// Docker's MCP catalog, mirrored. Nothing here may vary between runs (no dates, no run
// ids): every row is sent every hour, and the Worker's write-skip (rule 3) is what makes
// that free — a per-run value would turn 317 free rows into 317 writes an hour.
import { getJson } from "../lib/http.mjs";
import { makeEntry, licenseToSpdx, slug } from "../lib/entry.mjs";
const URL_ = "https://desktop.docker.com/mcp/catalog/v3/catalog.json";

export function normalise(catalog) {
  const out = [];
  for (const [key, s] of Object.entries(catalog.registry ?? {})) {
    if (s.type && s.type !== "server" && s.type !== "remote") continue;
    const title = s.title || key;
    const caps = [];
    for (const sec of s.secrets ?? []) caps.push({ kind: "secret", label: `Needs a ${title} key`, detail: sec.env || sec.name });
    if (s.oauth && Object.keys(s.oauth).length) caps.push({ kind: "secret", label: `Signs in to ${title} with your account` });
    if (s.disableNetwork) { /* no network line */ }
    else if (Array.isArray(s.allowHosts) && s.allowHosts.length) caps.push({ kind: "network", label: "Connects to the internet", detail: s.allowHosts.map((h) => h.replace(/:\d+$/, "")).slice(0, 3).join(", ") });
    else caps.push({ kind: "network", label: "Connects to the internet" });
    if (Array.isArray(s.volumes) && s.volumes.length) caps.push({ kind: "files", label: "Reads and writes folders you choose" });
    if (s.longLived) caps.push({ kind: "auto", label: "Keeps running in the background" });
    const tools = Array.isArray(s.tools) ? s.tools.length : 0;
    if (tools) caps.push({ kind: "adds", label: `Adds ${tools} tool${tools === 1 ? "" : "s"}` });
    const sha = String(s.source ?? "").match(/\/tree\/([0-9a-f]{7,40})/)?.[1];
    out.push(makeEntry({
      source: "docker", id: `docker-${slug(key)}`, itemType: "tool", displayName: title, description: s.description ?? "",
      author: s.metadata?.owner ?? "", repoUrl: s.upstream || undefined, tags: (s.metadata?.tags ?? []).slice(0, 6),
      category: s.metadata?.category === "productivity" ? "productivity" : "development",
      sourceType: "mcp-registry", sourceRef: `docker:${s.image ?? key}`,
      origin: String(s.image ?? "").startsWith("mcp/") ? "verified" : "community", mirroredFrom: "Docker MCP Catalog",
      license: licenseToSpdx(s.metadata?.license), upstreamId: key, stars: s.metadata?.githubStars, sourceCommit: sha,
      capabilities: caps, scan: { status: "unchecked" },
      publishedAt: s.dateAdded,
    }));
  }
  return out;
}

export async function collect({ log }) {
  const catalog = await getJson(URL_);
  const entries = normalise(catalog);
  log(`${Object.keys(catalog.registry ?? {}).length} servers → ${entries.length} rows`);
  return { entries };
}
