// GET /catalog serves ONE pre-built object, assembled at the end of an ingest run
// that changed something — not a fresh walk of ~5,000 D1 rows per request. The
// D1 build stays as the fallback, which is what makes this safe to ship: an
// unprovisioned namespace or a failed publish degrades to slower, never to broken.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { buildCatalogBody, publishCatalog, readPublished } from "../src/catalog/publish";
import { entry, TOKEN } from "./catalog-fixtures";

const post = (path: string, body: unknown) =>
  SELF.fetch(`https://test.local${path}`, { method: "POST", headers: TOKEN, body: JSON.stringify(body) });
const updatedAt = async () =>
  (await env.DB.prepare("SELECT updated_at FROM catalog_meta WHERE id = 'v'").first<{ updated_at: number }>())!.updated_at;

describe("the catalog is served from a pre-built object", () => {
  beforeEach(async () => {
    for (const t of ["catalog_items", "catalog_runs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare("UPDATE catalog_meta SET version = 1 WHERE id = 'v'").run();
  });

  it("finish publishes when the version moved, and GET /catalog serves that object", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("a")] });
    await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: [] });
    const published = await readPublished(env);
    expect(published).not.toBeNull();
    // Prove the route is serving the OBJECT, not the rows: corrupt the rows and
    // the response must not change.
    await env.DB.prepare("DELETE FROM catalog_items").run();
    const body = await (await SELF.fetch("https://test.local/catalog")).json<{ entries: Array<{ id: string }> }>();
    expect(body.entries.map((e) => e.id)).toEqual(["a"]);
  });

  it("a run that changed nothing does not republish", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("a")] });
    await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: [] });
    const first = (await readPublished(env))!.version;
    // Same entry again → merges to identical bytes → no write, no version bump (rule 3).
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r2", entries: [entry("a")] });
    await post("/admin/catalog/finish", { source: "docker", run_id: "r2", retire: [] });
    expect((await readPublished(env))!.version).toBe(first);
  });

  it("falls back to building from D1 when nothing has been published", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("z")] });
    await env.CATALOG_KV!.delete("catalog:current");
    const res = await SELF.fetch("https://test.local/catalog");
    expect(res.status).toBe(200);
    expect((await res.json<{ entries: Array<{ id: string }> }>()).entries.map((e) => e.id)).toEqual(["z"]);
  });

  it("the 304 is answered without reading the published object at all", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("a")] });
    await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: [] });
    const etag = (await SELF.fetch("https://test.local/catalog")).headers.get("etag")!;
    await env.CATALOG_KV!.delete("catalog:current");   // if the route touched it, this breaks
    const again = await SELF.fetch("https://test.local/catalog", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("the published body is byte-identical to what the D1 path builds", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("a"), entry("b")] });
    await publishCatalog(env);
    // Same generated_at the publisher stamped — that is the ONE input the two
    // callers pass in rather than read, so the comparison has to supply it too.
    expect((await readPublished(env))!.body).toBe(await buildCatalogBody(env.DB, await updatedAt()));
  });
});
