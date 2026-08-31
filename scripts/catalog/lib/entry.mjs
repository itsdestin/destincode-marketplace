// The shape the app reads: today's index.json row + `catalog`. Keep in step
// with desktop/src/shared/types.ts SkillEntry and catalog-types.ts CatalogMeta.
export const CATALOG_SOURCES = ["wecoded", "anthropic", "docker", "awesome-copilot", "cursorrules"];

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

const SPDX = new Map([
  ["mit license", "MIT"], ["mit", "MIT"],
  ["apache license 2.0", "Apache-2.0"], ["apache-2.0", "Apache-2.0"], ["apache 2.0", "Apache-2.0"],
  ["bsd 3-clause \"new\" or \"revised\" license", "BSD-3-Clause"], ["bsd-3-clause", "BSD-3-Clause"],
  ["bsd 2-clause \"simplified\" license", "BSD-2-Clause"], ["bsd-2-clause", "BSD-2-Clause"],
  ["gnu general public license v3.0", "GPL-3.0"], ["gpl-3.0", "GPL-3.0"],
  ["mozilla public license 2.0", "MPL-2.0"], ["mpl-2.0", "MPL-2.0"],
  ["isc license", "ISC"], ["isc", "ISC"], ["the unlicense", "Unlicense"], ["unlicense", "Unlicense"],
  ["creative commons zero v1.0 universal", "CC0-1.0"], ["cc0-1.0", "CC0-1.0"],
]);
export function licenseToSpdx(name) {
  if (!name || typeof name !== "string") return undefined;
  const k = name.trim().toLowerCase();
  if (k === "noassertion" || k === "other") return undefined;
  return SPDX.get(k) ?? (/^[A-Za-z0-9.+-]+$/.test(name.trim()) ? name.trim() : undefined);
}

const SOURCE_MARKETPLACE = { wecoded: "youcoded", anthropic: "anthropic", docker: "docker", "awesome-copilot": "awesome-copilot", cursorrules: "cursorrules" };

/** Build one catalog row. `source` is the ingest source name; everything the UI
 *  reads lives under `catalog`. Fields absent from the input are omitted, not
 *  nulled, so JSON stays small.
 *
 *  NOTHING in here may depend on the clock. The Worker skips writing a row whose
 *  merged JSON equals what it stored (rule 3); a `publishedAt: today` default would
 *  make every row "change" once a day and burn ~4,000 writes on nothing. Rows without
 *  a date get stamped by the Worker on first insert and keep that value. */
export function makeEntry(o) {
  const entry = {
    id: o.id,
    type: o.itemType === "prompt" ? "prompt" : "plugin",
    displayName: o.displayName,
    description: o.description ?? "",
    category: o.category ?? "development",
    author: o.author ?? "",
    tags: o.tags ?? [],
    version: o.version ?? "1.0.0",
    sourceMarketplace: SOURCE_MARKETPLACE[o.source ?? o.mirroredFromKey ?? "wecoded"] ?? o.source ?? "wecoded",
    sourceType: o.sourceType,
    sourceRef: o.sourceRef,
    catalog: {
      itemType: o.itemType,
      origin: { tier: o.origin, ...(o.mirroredFrom ? { mirroredFrom: o.mirroredFrom } : {}) },
      scan: o.scan,
      capabilities: o.capabilities ?? [],
      ...(o.license ? { license: o.license } : {}),
      ...(o.sourceCommit ? { sourceCommit: o.sourceCommit } : {}),
      ...(o.partOf ? { partOf: o.partOf } : {}),
      ...(o.upstreamId ? { upstreamId: o.upstreamId } : {}),
      ...(typeof o.stars === "number" ? { stars: o.stars } : {}),
    },
  };
  for (const k of ["publishedAt", "updatedAt", "sourceSubdir", "sourceSha", "repoUrl", "tagline", "longDescription", "lifeArea", "audience", "components", "prompt", "pluginName", "deprecated"]) {
    if (o[k] !== undefined) entry[k] = o[k];
  }
  return entry;
}
