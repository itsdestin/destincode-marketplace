import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePat, __resetPatCacheForTests } from "../src/auth/pat";
import { createTestAccount } from "./helpers";

const origFetch = globalThis.fetch;

describe("resolvePat", () => {
  beforeEach(async () => {
    __resetPatCacheForTests();
    // Identity PK is (provider, provider_user_id); clear so each test's fixed
    // githubId can be re-seeded without a UNIQUE collision.
    for (const t of ["identities", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("returns the account id when GitHub /user maps to a known identity", async () => {
    const acct = await createTestAccount({ githubId: "12345" });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 12345, login: "destin" }), { status: 200 })
    ) as any;
    const userId = await resolvePat(env.DB, "ghp_test");
    expect(userId).toBe(acct.userId);
  });

  it("returns null when the github id has no linked account", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 55555, login: "stranger" }), { status: 200 })
    ) as any;
    const userId = await resolvePat(env.DB, "ghp_unlinked");
    expect(userId).toBeNull();
  });

  it("returns null on 401 from GitHub", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad credentials", { status: 401 })) as any;
    const userId = await resolvePat(env.DB, "ghp_bad");
    expect(userId).toBeNull();
  });

  it("caches a successful lookup (second call does not re-fetch)", async () => {
    await createTestAccount({ githubId: "999" });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 999, login: "x" }), { status: 200 })
    );
    globalThis.fetch = fetchMock as any;
    await resolvePat(env.DB, "ghp_cache");
    await resolvePat(env.DB, "ghp_cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failed lookup", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    globalThis.fetch = fetchMock as any;
    await resolvePat(env.DB, "ghp_fail");
    await resolvePat(env.DB, "ghp_fail");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null for an empty token without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const userId = await resolvePat(env.DB, "");
    expect(userId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
