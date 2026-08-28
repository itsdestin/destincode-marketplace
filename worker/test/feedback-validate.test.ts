import { describe, it, expect } from "vitest";
import { parseVote, validateCommentText, MAX_COMMENT_LEN } from "../src/feedback/validate";

describe("parseVote", () => {
  it("maps up/down/null and rejects anything else", () => {
    expect(parseVote("up")).toBe(1);
    expect(parseVote("down")).toBe(-1);
    expect(parseVote(null)).toBeNull();
    expect(parseVote(undefined)).toBeNull();
    expect(() => parseVote("yes")).toThrow("value must be up, down or null");
    expect(() => parseVote(1)).toThrow("value must be up, down or null");
  });
});

describe("validateCommentText", () => {
  it("trims and returns the text", () => {
    expect(validateCommentText("  works great  ")).toBe("works great");
  });
  it("rejects empty, overlong, non-text and repeated-character spam", () => {
    expect(() => validateCommentText("   ")).toThrow("comment is empty");
    expect(() => validateCommentText("x".repeat(MAX_COMMENT_LEN + 1))).toThrow("comment too long");
    expect(() => validateCommentText("aaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow("comment appears to be spam");
    // A number is not an empty comment — saying so would be a wrong cause in a
    // user-facing string (CLAUDE.md → "Never write misleading error messages").
    expect(() => validateCommentText(42)).toThrow("comment must be text");
  });
  it("allows a link — the most useful comment on a plugin is often one", () => {
    expect(validateCommentText("known issue, see https://github.com/x/y/issues/3")).toContain("issues/3");
  });
  it("rejects a comment that is mostly links", () => {
    expect(() => validateCommentText("https://a.example https://b.example https://c.example https://d.example")).toThrow("too many links");
  });
  it("allows exactly MAX_COMMENT_LEN characters", () => {
    // Varied text, not "y".repeat(2000): 2000 identical characters is caught by
    // the repeated-run spam rule first, which is correct behaviour — that string
    // would test the wrong boundary.
    const atLimit = "ab".repeat(MAX_COMMENT_LEN / 2);
    expect(atLimit.length).toBe(MAX_COMMENT_LEN);
    expect(validateCommentText(atLimit).length).toBe(MAX_COMMENT_LEN);
  });
});
