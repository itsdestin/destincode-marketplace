// Catalog — Layer A of the marketplace overhaul (spec §2). Serve side of the
// ingest job in scripts/catalog/. Rows are whole SkillEntry objects; the app
// renders entry.catalog untouched.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireIngestToken } from "./auth";

export const catalogRoutes = new Hono<HonoEnv>();

catalogRoutes.post("/admin/catalog/finish", requireIngestToken, (c) => c.json({ ok: true }));
