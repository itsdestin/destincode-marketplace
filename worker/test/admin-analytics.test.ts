import { env, SELF } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function seedAdmin(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO users (id, github_login, created_at) VALUES (?, ?, ?)")
    .bind("github:admin", "admin", now).run();
  const token = "tok-admin";
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token))))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
    .bind(hash, "github:admin", now, now).run();
  return token;
}

function mockCfSql(rows: unknown[]) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ meta: [], data: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  ) as any;
}

const origFetch = globalThis.fetch;

async function clearAuth() {
  for (const t of ["sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("GET /admin/analytics/dau", () => {
  beforeEach(async () => { await clearAuth(); mockCfSql([{ day: "2026-05-15", devices: 5 }]); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("https://test.local/admin/analytics/dau");
    expect(res.status).toBe(401);
  });

  it("returns 'devices' column for an admin", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/dau", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ day: string; devices: number }>>();
    expect(body).toEqual([{ day: "2026-05-15", devices: 5 }]);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("count(DISTINCT blob2) AS devices");
  });

  // Test env config: CUTOVER_TIMESTAMP and KNOWN_DEV_DEVICES are set as
  // non-empty in [env.test.vars] (wrangler.toml). They flow into c.env at
  // route-handle time and should be interpolated into the SQL.
  it("includes cutover clause from CUTOVER_TIMESTAMP", async () => {
    const token = await seedAdmin();
    await SELF.fetch("https://test.local/admin/analytics/dau", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("toDateTime('2026-05-15T00:00:00Z')");
  });

  it("includes admin filter from KNOWN_DEV_DEVICES", async () => {
    const token = await seedAdmin();
    await SELF.fetch("https://test.local/admin/analytics/dau", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain(`AND blob2 NOT IN ('${"a".repeat(64)}')`);
  });

  it("?include_admins=1 omits the admin filter", async () => {
    const token = await seedAdmin();
    await SELF.fetch("https://test.local/admin/analytics/dau?include_admins=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).not.toContain("NOT IN");
  });
});

describe("GET /admin/analytics/mau", () => {
  beforeEach(async () => { await clearAuth(); mockCfSql([{ devices: 16 }]); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns devices count under mau key", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/mau", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ mau: number }>();
    expect(body).toEqual({ mau: 16 });
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("count(DISTINCT blob2) AS devices");
  });
});

describe("GET /admin/analytics/versions", () => {
  beforeEach(async () => { await clearAuth(); mockCfSql([{ version: "1.3.0", devices: 5 }]); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns devices column", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/versions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("count(DISTINCT blob2) AS devices");
    expect(sql).toContain("blob3 AS version");
  });
});

describe("GET /admin/analytics/platforms", () => {
  beforeEach(async () => { await clearAuth(); mockCfSql([{ platform: "desktop", devices: 11 }]); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns devices column", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/platforms", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("count(DISTINCT blob2) AS devices");
    expect(sql).toContain("blob4 AS platform");
  });
});

describe("GET /admin/analytics/countries", () => {
  beforeEach(async () => { await clearAuth(); mockCfSql([{ country: "US", devices: 15 }]); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns devices column", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/countries", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("count(DISTINCT blob2) AS devices");
    expect(sql).toContain("blob6 AS country");
    expect(sql).toContain("LIMIT 20");
  });
});

describe("GET /admin/analytics/regions", () => {
  beforeEach(async () => {
    await clearAuth();
    mockCfSql([
      { region: "US-CA", devices: 5 },
      { region: "US-TX", devices: 3 },
    ]);
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns top regions for an admin", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/regions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ region: string; devices: number }>>();
    expect(body).toEqual([
      { region: "US-CA", devices: 5 },
      { region: "US-TX", devices: 3 },
    ]);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("blob7 AS region");
    expect(sql).toContain("LIMIT 20");
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("https://test.local/admin/analytics/regions");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/analytics/installs (derived from first-seen)", () => {
  beforeEach(async () => {
    await clearAuth();
    mockCfSql([{ day: "2026-05-15", installs: 7 }]);
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns derived first-seen counts for an admin", async () => {
    const token = await seedAdmin();
    const res = await SELF.fetch("https://test.local/admin/analytics/installs?days=7", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ day: string; installs: number }>>();
    expect(body).toEqual([{ day: "2026-05-15", installs: 7 }]);
    const sql = (globalThis.fetch as any).mock.calls[0][1].body as string;
    expect(sql).toContain("MIN(timestamp) AS first_seen");
  });
});
