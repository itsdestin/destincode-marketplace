import { describe, it, expect } from "vitest";
import { adminFilterClause, cutoverClause } from "../src/lib/admin-filter";

describe("adminFilterClause", () => {
  it("returns empty string when KNOWN_DEV_DEVICES is unset", () => {
    expect(adminFilterClause({ KNOWN_DEV_DEVICES: "" } as any, false)).toBe("");
    expect(adminFilterClause({ KNOWN_DEV_DEVICES: undefined } as any, false)).toBe("");
  });

  it("returns empty string when include_admins=true", () => {
    expect(adminFilterClause({ KNOWN_DEV_DEVICES: "a".repeat(64) } as any, true)).toBe("");
  });

  it("returns NOT IN clause for valid 64-hex hashes", () => {
    const env = {
      KNOWN_DEV_DEVICES: `${"a".repeat(64)},${"b".repeat(64)}`,
    } as any;
    const clause = adminFilterClause(env, false);
    expect(clause).toBe(`AND blob2 NOT IN ('${"a".repeat(64)}','${"b".repeat(64)}')`);
  });

  it("strips non-hex characters defensively", () => {
    const env = {
      KNOWN_DEV_DEVICES: `${"a".repeat(64)}'); DROP TABLE--`,
    } as any;
    const clause = adminFilterClause(env, false);
    // The injection attempt is reduced to hex chars only; the dropped string
    // becomes a < 64-char hash and is rejected by the length filter.
    expect(clause).toBe(`AND blob2 NOT IN ('${"a".repeat(64)}')`);
  });

  it("rejects hashes that aren't exactly 64 hex chars", () => {
    const env = {
      KNOWN_DEV_DEVICES: `short,${"a".repeat(64)},${"b".repeat(63)}`,
    } as any;
    const clause = adminFilterClause(env, false);
    expect(clause).toBe(`AND blob2 NOT IN ('${"a".repeat(64)}')`);
  });
});

describe("cutoverClause", () => {
  it("returns empty when CUTOVER_TIMESTAMP is unset", () => {
    expect(cutoverClause({ CUTOVER_TIMESTAMP: "" } as any)).toBe("");
    expect(cutoverClause({ CUTOVER_TIMESTAMP: undefined } as any)).toBe("");
  });

  it("returns AND clause when set", () => {
    expect(cutoverClause({ CUTOVER_TIMESTAMP: "2026-05-15T00:00:00Z" } as any))
      .toBe("AND timestamp > toDateTime('2026-05-15T00:00:00Z')");
  });

  it("strips characters that would break SQL string quoting", () => {
    // ISO 8601 chars only: digits, T, Z, :, -, .. Apostrophes and other risky
    // chars get filtered.
    expect(cutoverClause({ CUTOVER_TIMESTAMP: "2026-05-15'); DROP--" } as any))
      .toBe("AND timestamp > toDateTime('2026-05-15')");
  });
});
