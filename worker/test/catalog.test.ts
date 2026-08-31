// The ingest routes and the public reads. The three rules these lock in are the
// ones that keep an hourly job inside D1's free tier and keep a degraded run from
// visibly damaging the catalog — see the plan's Architecture section.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";
import { entry, TOKEN } from "./catalog-fixtures";

const post = (path: string, body: unknown) => SELF.fetch(`https://test.local${path}`, { method: "POST", headers: TOKEN, body: JSON.stringify(body) });
const version = async () => (await env.DB.prepare("SELECT version FROM catalog_meta WHERE id = 'v'").first<{ version: number }>())!.version;
const stored = async (id: string) => JSON.parse((await env.DB.prepare("SELECT entry_json FROM catalog_items WHERE id = ?").bind(id).first<{ entry_json: string }>())!.entry_json);

describe("catalog ingest routes", () => {
  beforeEach(async () => {
    for (const t of ["catalog_items", "catalog_runs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("upserts rows, indexes type / part_of, and reports the count", async () => {
    const res = await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [
      entry("bundle"),
      entry("bundle/skill-a", { catalog: { itemType: "skill", partOf: { id: "bundle", displayName: "Bundle" }, origin: { tier: "community" }, scan: { status: "unchecked" }, capabilities: [] } }),
    ] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upserted: 2, unchanged: 0 });
    const row = await env.DB.prepare("SELECT item_type, part_of_id FROM catalog_items WHERE id = ?").bind("bundle/skill-a").first();
    expect(row).toEqual({ item_type: "skill", part_of_id: "bundle" });
  });

  it("a second upsert of the same id replaces the row", async () => {
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [entry("x", { description: "old" })] });
    const res = await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r2", entries: [entry("x", { description: "new" })] });
    expect(await res.json()).toEqual({ ok: true, upserted: 1, unchanged: 0 });
    expect((await stored("x")).description).toBe("new");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM catalog_items").first<{ n: number }>())!.n).toBe(1);
  });

  it("an IDENTICAL upsert writes nothing and leaves the catalog version alone", async () => {
    // This is the write budget: Docker and copilot send every row every hour, and D1's
    // free tier allows 100,000 row-writes a day. Unchanged must cost zero writes.
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("same")] });
    const before = await version();
    const res = await post("/admin/catalog/upsert", { source: "docker", run_id: "r2", entries: [entry("same")] });
    expect(await res.json()).toEqual({ ok: true, upserted: 0, unchanged: 1 });
    expect(await version()).toBe(before);
  });

  it("stamps publishedAt on first sight and keeps it afterwards", async () => {
    const { publishedAt: _drop, ...noDate } = entry("dated");
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [noDate] });
    const first = (await stored("dated")).publishedAt as string;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const res = await post("/admin/catalog/upsert", { source: "docker", run_id: "r2", entries: [noDate] });
    expect(await res.json()).toEqual({ ok: true, upserted: 0, unchanged: 1 });   // the stamp did not make it "changed"
    expect((await stored("dated")).publishedAt).toBe(first);
  });

  it("finish retires exactly the listed ids of that source, and records the run", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("docker-a"), entry("docker-b")] });
    const res = await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: ["docker-b"] });
    expect(await res.json()).toEqual({ ok: true, retired: 1 });
    const dep = async (id: string) => (await env.DB.prepare("SELECT deprecated FROM catalog_items WHERE id = ?").bind(id).first<{ deprecated: number }>())!.deprecated;
    expect(await dep("docker-b")).toBe(1);
    expect(await dep("docker-a")).toBe(0);
    const run = await env.DB.prepare("SELECT upserted, retired, finished_at FROM catalog_runs WHERE id = 'r1' AND source = 'docker'")
      .first<{ upserted: number; retired: number; finished_at: number }>();
    expect(run).toMatchObject({ upserted: 2, retired: 1 });
    expect(run!.finished_at).toBeGreaterThan(0);
  });

  it("finish never touches another source's rows, even if named", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("docker-a")] });
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [entry("w1")] });
    const res = await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: ["w1"] });
    expect(await res.json()).toEqual({ ok: true, retired: 0 });
  });

  it("finish REFUSES to retire most of a source in one run", async () => {
    // A scraper whose upstream moved a folder: 20 rows last hour, 2 this hour → an 18-id list.
    const many = Array.from({ length: 20 }, (_, i) => entry(`c${String(i).padStart(2, "0")}`));
    await post("/admin/catalog/upsert", { source: "cursorrules", run_id: "r1", entries: many });
    await post("/admin/catalog/finish", { source: "cursorrules", run_id: "r1", retire: [] });
    const gone = many.slice(2).map((e) => e.id);
    const res = await post("/admin/catalog/finish", { source: "cursorrules", run_id: "r2", retire: gone });
    expect(await res.json()).toEqual({ ok: true, retired: 0, refused: { wouldRetire: 18, live: 20 } });
    // Nothing was delisted, and the refusal is on the run record.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE deprecated = 1").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT note FROM catalog_runs WHERE id = 'r2' AND source = 'cursorrules'").first<{ note: string }>())!.note)
      .toMatch(/refused/);
    // …and the override goes through.
    const forced = await post("/admin/catalog/finish", { source: "cursorrules", run_id: "r2", retire: gone, allow_mass_retire: true });
    expect((await forced.json<{ retired: number }>()).retired).toBe(18);
  });

  it("health reports live counts and when each source last finished", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("h1"), entry("h2")] });
    await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: [] });
    // Admin identity, not the ingest token — this one is for a person, not the robot.
    // Same helper pair the reports tests use (test/helpers.ts); githubId 424242 is the
    // id configured in [env.test.vars] ADMIN_USER_IDS.
    const token = await issueTestSession(await createTestAccount({ githubId: "424242", login: "admin" }));
    const res = await SELF.fetch("https://test.local/admin/catalog/health", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json<{ sources: Array<{ source: string; live: number; lastFinishedAt: number }> }>();
    expect(body.sources).toEqual([expect.objectContaining({ source: "docker", live: 2 })]);
    expect(body.sources[0]!.lastFinishedAt).toBeGreaterThan(0);
    // …and the ingest token alone does not open it — a robot credential is not a person.
    expect((await SELF.fetch("https://test.local/admin/catalog/health", { headers: { "X-Catalog-Token": "test-ingest-token" } })).status).toBe(401);
  });

  it("a small source is exempt from the retire guard", async () => {
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("s1"), entry("s2"), entry("s3")] });
    expect((await (await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: ["s2", "s3"] })).json<{ retired: number }>()).retired).toBe(2);
  });

  it("a write bumps the catalog version, a retire bumps it, an empty finish does not", async () => {
    const before = await version();
    await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [
      entry("vv", { catalog: { itemType: "tool", origin: { tier: "community" }, capabilities: [],
        sourceCommit: "abc1234", scan: { status: "checked", checkedAt: "2026-08-28T00:00:00Z", rules: "3" } } }),
    ] });
    const afterWrite = await version();
    expect(afterWrite).toBeGreaterThan(before);
    await post("/admin/catalog/finish", { source: "docker", run_id: "r1", retire: [] });
    expect(await version()).toBe(afterWrite);                 // nothing changed for a client
    await post("/admin/catalog/finish", { source: "docker", run_id: "r2", retire: ["vv"] });
    expect(await version()).toBeGreaterThan(afterWrite);      // a delisting is a change
  });

  it("rejects batches over 500, ids over 128 chars, or a missing source", async () => {
    const big = Array.from({ length: 501 }, (_, i) => entry(`e${i}`));
    expect((await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: big })).status).toBe(400);
    expect((await post("/admin/catalog/upsert", { source: "docker", run_id: "r1", entries: [entry("x".repeat(129))] })).status).toBe(400);
    expect((await post("/admin/catalog/upsert", { run_id: "r1", entries: [entry("q")] })).status).toBe(400);
  });

  it("NEVER downgrades: a degraded run keeps the stored scan, licence, stars and commit — and writes nothing", async () => {
    const good = entry("keeper", { catalog: { itemType: "plugin", origin: { tier: "youcoded" },
      scan: { status: "checked", checkedAt: "2026-08-28T00:00:00Z" },
      capabilities: [{ kind: "shell", label: "Runs commands on your computer" }],
      license: "MIT", sourceCommit: "abc1234", stars: 91 } });
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [good] });

    // r2 is what a rate-limited run emits: it could not read the files or the repo.
    const degraded = entry("keeper", { catalog: { itemType: "plugin", origin: { tier: "youcoded" },
      scan: { status: "unchecked" }, capabilities: [] } });
    const res = await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r2", entries: [degraded] });
    // Merged back to exactly what was stored → the write-skip sees no difference.
    expect(await res.json()).toEqual({ ok: true, upserted: 0, unchanged: 1 });

    const cat = (await stored("keeper")).catalog;
    expect(cat.scan).toEqual({ status: "checked", checkedAt: "2026-08-28T00:00:00Z" });
    expect(cat.license).toBe("MIT");
    expect(cat.stars).toBe(91);
    expect(cat.sourceCommit).toBe("abc1234");
    expect(cat.capabilities).toHaveLength(1);
  });

  it("an UPGRADE still wins — a real scan replaces an unchecked one", async () => {
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [entry("up")] });
    const better = entry("up", { catalog: { itemType: "plugin", origin: { tier: "youcoded" },
      scan: { status: "caution", checkedAt: "2026-08-28T01:00:00Z", findings: ["Downloads and runs code from the internet (install.sh)"] },
      capabilities: [], license: "MIT", sourceCommit: "def5678" } });
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r2", entries: [better] });
    const cat = (await stored("up")).catalog;
    expect(cat.scan.status).toBe("caution");
    expect(cat.scan.findings).toHaveLength(1);
  });

  it("shas lists EVERY live id with its commit and rule version, and drops retired ones", async () => {
    await post("/admin/catalog/upsert", { source: "wecoded", run_id: "r1", entries: [
      entry("a", { catalog: { itemType: "plugin", origin: { tier: "youcoded" }, scan: { status: "checked", rules: "1" }, capabilities: [], sourceCommit: "aaa1111" } }),
      entry("b"),   // no commit, no rules — still listed, so the ingest knows it exists
    ] });
    const shas = async () => (await (await SELF.fetch("https://test.local/admin/catalog/shas?source=wecoded", { headers: TOKEN })).json<{ shas: Record<string, string> }>()).shas;
    expect(await shas()).toEqual({ a: "aaa1111:1", b: ":" });
    await post("/admin/catalog/finish", { source: "wecoded", run_id: "r1", retire: ["b"] });
    expect(await shas()).toEqual({ a: "aaa1111:1" });
  });
});
