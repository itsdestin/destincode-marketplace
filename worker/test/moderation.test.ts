import { describe, it, expect } from "vitest";
import { classifyReview } from "../src/ratings/moderation";
import { validateReviewText, MAX_REVIEW_LEN } from "../src/ratings/moderation";

describe("validateReviewText", () => {
  it("returns null for null/empty/whitespace", () => {
    expect(validateReviewText(null)).toBeNull();
    expect(validateReviewText("")).toBeNull();
    expect(validateReviewText("   ")).toBeNull();
  });
  it("trims valid text", () => {
    expect(validateReviewText("  great plugin  ")).toBe("great plugin");
  });
  it("throws on over-length text", () => {
    expect(() => validateReviewText("a".repeat(MAX_REVIEW_LEN + 1))).toThrow(/too long/);
  });
  it("rejects URLs", () => {
    expect(() => validateReviewText("check http://spam.example")).toThrow(/URLs/);
  });
  it("rejects repeated-char spam", () => {
    expect(() => validateReviewText("aaaaaaaaaaa")).toThrow(/spam/);
  });
});

const fakeAi = (response: string) => ({ run: async () => ({ response }) }) as unknown as Ai;

describe("classifyReview", () => {
  it("flags text the guard model calls unsafe, and reports the category", async () => {
    const verdict = await classifyReview(fakeAi("unsafe\nS1"), "nasty");
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toBe("s1");
  });

  it("passes text the guard model calls safe", async () => {
    expect(await classifyReview(fakeAi("safe"), "works great")).toEqual({ safe: true });
  });

  it("matches case-insensitively — the model does not promise casing", async () => {
    expect((await classifyReview(fakeAi("UNSAFE\nS10"), "x")).safe).toBe(false);
  });

  it("FAIL-OPENS when there is no AI binding — this is why route tests can't cover it", async () => {
    expect(await classifyReview(undefined, "anything")).toEqual({ safe: true });
    expect(await classifyReview({} as unknown as Ai, "anything")).toEqual({ safe: true });
  });

  it("treats an empty model response as safe rather than throwing", async () => {
    expect(await classifyReview(fakeAi(""), "x")).toEqual({ safe: true });
  });
});
