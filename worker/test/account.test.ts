import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

async function authed(path: string, token: string, init?: RequestInit) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

describe("PATCH /auth/profile", () => {
  it("updates display_name", async () => {
    const acct = await createTestAccount({ login: "octo" });
    const token = await issueTestSession(acct);
    const res = await authed("/auth/profile", token, { method: "PATCH", body: JSON.stringify({ display_name: "Octo Prime" }) });
    expect(res.status).toBe(200);
    const me = await (await authed("/auth/me", token)).json() as { display_name: string };
    expect(me.display_name).toBe("Octo Prime");
  });

  it("rejects empty and over-long names", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    for (const bad of ["", "   ", "x".repeat(61)]) {
      const res = await authed("/auth/profile", token, { method: "PATCH", body: JSON.stringify({ display_name: bad }) });
      expect(res.status).toBe(400);
    }
  });
});

describe("PUT /auth/handle", () => {
  it("sets a handle (lowercased) and returns it from /auth/me", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "Dest-In1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "dest-in1" });
    const me = await (await authed("/auth/me", token)).json() as { handle: string };
    expect(me.handle).toBe("dest-in1");
  });

  it("rejects invalid formats and reserved names", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    for (const bad of ["ab", "-lead", "sp ace", "ünïcode", "x".repeat(31), "youcoded", "admin"]) {
      const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: bad }) });
      expect(res.status, `handle ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("refuses a handle already taken (409)", async () => {
    await createTestAccount({ handle: "taken" });
    const b = await createTestAccount();
    const token = await issueTestSession(b);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "taken" }) });
    expect(res.status).toBe(409);
  });

  it("re-PUTting the current handle is a 200 no-op with no cooldown release", async () => {
    // A spurious handle_releases row here would cooldown-lock a handle that
    // was never actually freed — the user still owns it.
    const acct = await createTestAccount({ handle: "keeper" });
    const token = await issueTestSession(acct);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "keeper" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "keeper" });
    const rel = await env.DB.prepare("SELECT handle FROM handle_releases WHERE handle = 'keeper'").first();
    expect(rel).toBeNull();
  });

  it("puts the old handle into a 30-day cooldown on rename, and refuses cooldown handles", async () => {
    const a = await createTestAccount();
    const tokenA = await issueTestSession(a);
    await authed("/auth/handle", tokenA, { method: "PUT", body: JSON.stringify({ handle: "first" }) });
    await authed("/auth/handle", tokenA, { method: "PUT", body: JSON.stringify({ handle: "second" }) });

    const rel = await env.DB.prepare("SELECT handle FROM handle_releases WHERE handle = 'first'").first();
    expect(rel).not.toBeNull();

    const b = await createTestAccount();
    const tokenB = await issueTestSession(b);
    const res = await authed("/auth/handle", tokenB, { method: "PUT", body: JSON.stringify({ handle: "first" }) });
    expect(res.status).toBe(409); // cooldown
  });
});
