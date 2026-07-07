// CORS contract tests — locks in the security boundary between public-read
// endpoints (any origin, GET only) and everything else (strict allowlist).
//
// Why this matters: Android WebView loads React from `file:///android_asset/`
// and sends `Origin: null`, which is intentionally NOT in ALLOWED_ORIGINS.
// We allow `null` (and any other origin) to read public data — but writes
// must still be gated by the strict allowlist as a defense-in-depth layer
// on top of the Bearer-token check. A regression here would either:
//   (a) re-break "Couldn't load reviews" on Android, or
//   (b) silently broaden write-endpoint CORS to null-origin contexts.
//
// Browser CORS is enforced by the BROWSER, not the server — the server's job
// is to send the right headers, the browser's job is to honor them. These
// tests verify the server sends the right headers; they don't simulate a
// real browser CORS check.

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("CORS — public read endpoints", () => {
  it("GET /stats accepts any origin (Origin: null included)", async () => {
    const res = await SELF.fetch("https://test.local/stats", {
      headers: { Origin: "null" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /stats accepts Origin: https://evil.example.com (data is public)", async () => {
    const res = await SELF.fetch("https://test.local/stats", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /ratings/:plugin_id accepts any origin", async () => {
    const res = await SELF.fetch("https://test.local/ratings/some-plugin", {
      headers: { Origin: "null" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("OPTIONS preflight for GET /ratings/:plugin_id from null origin succeeds", async () => {
    const res = await SELF.fetch("https://test.local/ratings/some-plugin", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    // Hono's cors middleware returns 204 No Content for valid preflights.
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const allowedMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowedMethods).toContain("GET");
  });
});

describe("CORS — strict allowlist for writes & non-public paths", () => {
  it("Origin allowed: app://youcoded reflects in Access-Control-Allow-Origin", async () => {
    const res = await SELF.fetch("https://test.local/installs", {
      method: "OPTIONS",
      headers: {
        Origin: "app://youcoded",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("app://youcoded");
  });

  it("Origin disallowed: null on POST /installs gets no Allow-Origin header", async () => {
    const res = await SELF.fetch("https://test.local/installs", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    // No Access-Control-Allow-Origin header means the browser will block the
    // actual POST. The status code on a CORS-rejected preflight is
    // implementation-defined (Hono returns 204 with no Allow-Origin header).
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("DELETE /ratings/:plugin_id stays on strict allowlist (auth-write)", async () => {
    const res = await SELF.fetch("https://test.local/ratings/some-plugin", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    // Same path as the public GET, but DELETE method falls through to strictCors.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("POST /ratings (no plugin_id segment) stays on strict allowlist", async () => {
    const res = await SELF.fetch("https://test.local/ratings", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("Preflight for PATCH /auth/profile from an allowed origin advertises PATCH and PUT", async () => {
    // The account endpoints (PATCH /auth/profile, PUT /auth/handle) are called
    // by the renderer directly under CORS — the preflight must advertise both
    // methods or the browser blocks the actual request before it's sent.
    const res = await SELF.fetch("https://test.local/auth/profile", {
      method: "OPTIONS",
      headers: {
        Origin: "app://youcoded",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("app://youcoded");
    const allowedMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowedMethods).toContain("PATCH");
    expect(allowedMethods).toContain("PUT");
  });

  it("Preflight for PUT /auth/handle from an allowed origin advertises PUT", async () => {
    const res = await SELF.fetch("https://test.local/auth/handle", {
      method: "OPTIONS",
      headers: {
        Origin: "app://youcoded",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("app://youcoded");
    expect(res.headers.get("Access-Control-Allow-Methods") ?? "").toContain("PUT");
  });

  it("Multi-segment /ratings/foo/bar path falls through to strict (not a public read)", async () => {
    const res = await SELF.fetch("https://test.local/ratings/foo/bar", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
