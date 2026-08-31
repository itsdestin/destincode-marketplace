import type { Env } from "../types";

// Only the two bindings the publisher touches. Deliberately NOT the whole Env:
// tests pass cloudflare:test's `env`, which does not carry every production
// binding, and nothing in here needs them.
export type CatalogEnv = Pick<Env, "DB" | "CATALOG_KV">;

const POINTER = "catalog:current";
const KEEP = 2; // current + the one before it, so a bad publish rolls back by pointer

// The catalog body, built from D1. This is the SAME function the route's fallback
// uses, extracted so the served bytes and the published bytes can never drift.
//
// Keyset paging (`id > last`), never OFFSET: D1 bills rows SCANNED, and OFFSET
// re-scans everything it skips (~27,500 row-reads instead of ~5,000 for 5,000 rows).
// The stored JSON is concatenated, never parsed and re-serialised — at a few thousand
// rows that is megabytes of pointless work.
export async function buildCatalogBody(db: D1Database, generatedAt = 0): Promise<string> {
  const parts: string[] = [];
  let after = "";
  for (;;) {
    const { results } = await db
      .prepare("SELECT id, entry_json FROM catalog_items WHERE deprecated = 0 AND id > ? ORDER BY id LIMIT 500")
      .bind(after).all<{ id: string; entry_json: string }>();
    for (const r of results) parts.push(r.entry_json);
    if (results.length < 500) break;
    after = results[results.length - 1]!.id;
  }
  return `{"generated_at":${generatedAt},"entries":[${parts.join(",")}]}`;
}

/** Assemble the whole catalog once and store it. Called from `finish` ONLY when the
 *  run actually changed rows — republishing an unchanged catalog would rewrite a
 *  multi-MB object 24 times a day for nothing. */
export async function publishCatalog(env: CatalogEnv): Promise<{ version: number; bytes: number } | null> {
  if (!env.CATALOG_KV) return null;                       // unprovisioned → route falls back to D1
  const meta = await env.DB.prepare("SELECT version, updated_at FROM catalog_meta WHERE id = 'v'")
    .first<{ version: number; updated_at: number }>();
  const version = meta?.version ?? 0;
  const body = await buildCatalogBody(env.DB, meta?.updated_at ?? 0);
  const key = `catalog:v${version}`;
  // Versioned key first, pointer second: a reader mid-flight either sees the old
  // pointer (old object, still intact) or the new one (new object, fully written).
  // A single mutable key could serve half of one catalog and half of the next.
  await env.CATALOG_KV.put(key, body);
  await env.CATALOG_KV.put(POINTER, JSON.stringify({ version, key, generatedAt: meta?.updated_at ?? 0 }));
  // Best-effort GC of anything older than the last KEEP versions. A miss is harmless:
  // KV storage is measured in GB and these objects are megabytes.
  for (let v = version - KEEP; v > version - KEEP - 5 && v > 0; v--) {
    try { await env.CATALOG_KV.delete(`catalog:v${v}`); } catch { /* best-effort */ }
  }
  return { version, bytes: body.length };
}

/** The published catalog, or null on ANY miss — caller falls back to D1. */
export async function readPublished(env: CatalogEnv): Promise<{ version: number; body: string } | null> {
  if (!env.CATALOG_KV) return null;
  try {
    const ptr = await env.CATALOG_KV.get(POINTER, "json") as { version: number; key: string } | null;
    if (!ptr) return null;
    const body = await env.CATALOG_KV.get(ptr.key, "text");
    return body ? { version: ptr.version, body } : null;
  } catch {
    return null;                                          // degrade to D1, never to an error
  }
}

/** The version of the object the public route is actually serving. Lags `version`
 *  only if a publish failed — which is invisible from outside, because the D1
 *  fallback keeps answering correctly while quietly paying the old price.
 *  Reads the POINTER only, never the multi-MB body. */
export async function publishedVersion(env: CatalogEnv): Promise<number | null> {
  if (!env.CATALOG_KV) return null;
  try {
    const ptr = await env.CATALOG_KV.get(POINTER, "json") as { version: number } | null;
    return ptr ? ptr.version : null;
  } catch {
    return null;
  }
}
