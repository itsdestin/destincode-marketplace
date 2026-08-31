// One entry shape, shared by every catalog suite. Kept out of catalog.test.ts so
// the publish suite can build the same rows without duplicating the shape — two
// copies would drift the moment CatalogMeta gains a field.

/** A minimal SkillEntry + catalog block, as the ingest would POST it. */
export const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: "plugin", displayName: id, description: "d", category: "development", author: "a", tags: [],
  version: "1.0.0", publishedAt: "2026-08-28T00:00:00Z", sourceMarketplace: "youcoded",
  sourceType: "url", sourceRef: "https://github.com/x/y.git",
  catalog: { itemType: "plugin", origin: { tier: "community" }, scan: { status: "unchecked" }, capabilities: [] },
  ...extra,
});

/** Headers an ingest call carries: JSON body + the shared ingest secret. */
export const TOKEN = { "Content-Type": "application/json", "X-Catalog-Token": "test-ingest-token" };
