import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { badRequest, tooMany } from "../lib/errors";
import { checkRateLimit } from "../lib/rate-limit";
import { writeAppEvent } from "../lib/analytics";

export const appRoutes = new Hono<HonoEnv>();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[a-f0-9]{64}$/i;
const PLATFORMS = new Set(["desktop", "android"]);
const MAX_VERSION_LEN = 32;
const MAX_OS_LEN = 16;

interface AppEventBody {
  installId?: unknown;        // LEGACY — accepted but no AE write
  deviceIdHash?: unknown;     // NEW — required for AE write
  appVersion?: unknown;
  platform?: unknown;
  os?: unknown;
}

interface ParsedBody {
  deviceIdHash: string | null;   // null for legacy installId-only payloads
  appVersion: string;
  platform: "desktop" | "android";
  os: string;
}

// Validates the payload. Accepts either legacy `installId` (UUID) or new
// `deviceIdHash` (hex64). The discriminator: deviceIdHash is preferred when
// both are present. Legacy installId-only payloads return ParsedBody with
// deviceIdHash=null, signaling "do not write to AE."
function parseBody(body: AppEventBody): ParsedBody {
  const installId = typeof body.installId === "string" ? body.installId : "";
  const deviceIdHash = typeof body.deviceIdHash === "string" ? body.deviceIdHash : "";
  const appVersion = typeof body.appVersion === "string" ? body.appVersion : "";
  const platform = typeof body.platform === "string" ? body.platform : "";
  const os = typeof body.os === "string" ? body.os : "";

  const validInstallId = installId !== "" && UUID_V4.test(installId);
  const validDeviceHash = deviceIdHash !== "" && HEX_64.test(deviceIdHash);

  // Reject if both are present but malformed, OR neither is present, OR an
  // installId is present but malformed (catches typos in current clients).
  if (!validInstallId && !validDeviceHash) throw badRequest("invalid request");
  if (deviceIdHash !== "" && !validDeviceHash) throw badRequest("invalid request");
  if (installId !== "" && !validInstallId) throw badRequest("invalid request");

  if (!appVersion || appVersion.length > MAX_VERSION_LEN) throw badRequest("invalid request");
  if (!PLATFORMS.has(platform)) throw badRequest("invalid request");
  if (os.length > MAX_OS_LEN) throw badRequest("invalid request");

  return {
    deviceIdHash: validDeviceHash ? deviceIdHash : null,
    appVersion,
    platform: platform as "desktop" | "android",
    os,
  };
}

function clientIp(c: any): string {
  return c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
}

async function handleHeartbeat(c: any) {
  const ip = clientIp(c);
  if (!(await checkRateLimit(`app-heartbeat:${ip}`, 30, 3600))) {
    throw tooMany("too many requests");
  }
  const body = (await c.req.json().catch(() => ({}))) as AppEventBody;
  const parsed = parseBody(body);

  // Legacy installId-only payload: 200 OK, no AE write. Lets old clients
  // advance their lastPingedDate and stop retrying that day.
  if (parsed.deviceIdHash === null) {
    return c.json({ ok: true });
  }

  const country = c.req.header("CF-IPCountry") || "";
  const region = c.req.header("CF-IPRegionCode") || "";
  writeAppEvent(c.env, {
    deviceIdHash: parsed.deviceIdHash,
    appVersion: parsed.appVersion,
    platform: parsed.platform,
    os: parsed.os,
    country,
    region,
  });
  return c.json({ ok: true });
}

// POST /app/heartbeat — fired at most once/day per device.
appRoutes.post("/app/heartbeat", handleHeartbeat);

// POST /app/install — DEPRECATED. Returns 410 Gone. Legacy clients still
// post here; the response body says nothing (clients fire-and-forget),
// they just stop expecting an "ok" and never advance state. They WILL
// keep retrying once per launch, but the rate limit + 410 keeps it cheap.
appRoutes.post("/app/install", (c) => c.json({ deprecated: true }, 410));
