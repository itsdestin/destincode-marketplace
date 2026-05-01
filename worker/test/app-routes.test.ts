import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";

const LEGACY_PAYLOAD = {
  installId: "c4b2a8f0-0000-4000-8000-000000000000",
  appVersion: "1.2.1",
  platform: "desktop",
  os: "mac",
};
const NEW_PAYLOAD = {
  deviceIdHash: "a".repeat(64),
  appVersion: "1.3.0",
  platform: "desktop",
  os: "mac",
};

describe("POST /app/heartbeat — new device-hash payload", () => {
  let writes: any[];
  let writeDataPoint: any;

  beforeEach(() => {
    writes = [];
    writeDataPoint = vi.fn((dp: any) => writes.push(dp));
    (env as any).APP_ANALYTICS = { writeDataPoint };
  });

  afterEach(() => {
    delete (env as any).APP_ANALYTICS;
  });

  it("accepts deviceIdHash and writes to AE", async () => {
    const res = await app.request("/app/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-IPCountry": "US", "CF-IPRegionCode": "CA" },
      body: JSON.stringify(NEW_PAYLOAD),
    }, env);
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].blobs[1]).toBe("a".repeat(64));
    expect(writes[0].blobs[5]).toBe("US");
    expect(writes[0].blobs[6]).toBe("CA");
  });

  it("accepts legacy installId payload but does NOT write to AE (soak drop)", async () => {
    const res = await app.request("/app/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LEGACY_PAYLOAD),
    }, env);
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
  });

  it("rejects malformed deviceIdHash (wrong length)", async () => {
    const res = await app.request("/app/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...NEW_PAYLOAD, deviceIdHash: "abc" }),
    }, env);
    expect(res.status).toBe(400);
  });

  it("rejects payload with neither installId nor deviceIdHash", async () => {
    const res = await app.request("/app/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appVersion: "1.0", platform: "desktop", os: "mac" }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe("POST /app/install — deprecated, returns 410", () => {
  it("returns 410 Gone with no AE write", async () => {
    const writes: any[] = [];
    (env as any).APP_ANALYTICS = { writeDataPoint: (dp: any) => writes.push(dp) };
    const res = await app.request("/app/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(LEGACY_PAYLOAD),
    }, env);
    expect(res.status).toBe(410);
    expect(writes).toHaveLength(0);
    delete (env as any).APP_ANALYTICS;
  });
});
