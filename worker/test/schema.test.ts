import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("schema", () => {
  it("has users, installs, ratings, theme_likes, reports, thumbs, comments tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r: { name: string }) => r.name);
    expect(names).toContain("users");
    expect(names).toContain("identities");
    expect(names).toContain("sessions");
    expect(names).toContain("device_codes");
    expect(names).toContain("installs");
    expect(names).toContain("ratings");
    expect(names).toContain("theme_likes");
    expect(names).toContain("reports");
    expect(names).toContain("thumbs");
    expect(names).toContain("comments");
  });
});
