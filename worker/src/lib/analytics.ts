// Privacy-by-construction wrapper around env.APP_ANALYTICS.writeDataPoint.
// Enforces the blob order that all /admin/analytics/* SQL queries assume.
// No caller outside this file should ever touch env.APP_ANALYTICS directly.
import type { Env } from "../types";

export interface AppEventPayload {
  deviceIdHash: string;       // 64-char hex (HMAC-SHA256 client-side)
  appVersion: string;
  platform: "desktop" | "android";
  os: string;                 // "win" | "mac" | "linux" for desktop; "" on android
  country: string;            // ISO 2-letter from CF-IPCountry, or ""
  region: string;             // ISO 3166-2 from CF-IPRegionCode, or ""
}

// The optional chaining is load-bearing: tests run with APP_ANALYTICS undefined
// because vitest-pool-workers can't resolve the binding. Production always has it.
export function writeAppEvent(env: Env, payload: AppEventPayload): void {
  env.APP_ANALYTICS?.writeDataPoint({
    blobs: [
      "heartbeat",            // blob1 — vestigial, retained for forward-compat
      payload.deviceIdHash,   // blob2 — semantically replaces install_id
      payload.appVersion,     // blob3
      payload.platform,       // blob4
      payload.os,             // blob5
      payload.country,        // blob6
      payload.region,         // blob7 — NEW
    ],
    doubles: [],
    indexes: ["heartbeat"],
  });
}
