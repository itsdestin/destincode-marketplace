// The ingest token gate. POST /admin/catalog/* is called by a GitHub Action, not
// by a person — so it is guarded by a shared secret header rather than a session.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("ingest token", () => {
  it("401s without the header, 401s with a wrong token, 200s with the test token", async () => {
    const body = JSON.stringify({ source: "docker", run_id: "r1", retire: [] });
    const headers = { "Content-Type": "application/json" };
    expect((await SELF.fetch("https://test.local/admin/catalog/finish", { method: "POST", headers, body })).status).toBe(401);
    expect((await SELF.fetch("https://test.local/admin/catalog/finish", { method: "POST", headers: { ...headers, "X-Catalog-Token": "nope" }, body })).status).toBe(401);
    expect((await SELF.fetch("https://test.local/admin/catalog/finish", { method: "POST", headers: { ...headers, "X-Catalog-Token": "test-ingest-token" }, body })).status).toBe(200);
  });
});
