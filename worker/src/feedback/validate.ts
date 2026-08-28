// Input rules for the feedback routes. Pure functions (no bindings) so they
// test without the worker runtime. They throw plain Error — the route wraps
// the message in badRequest(), the same split ratings/moderation.ts uses.

export const MAX_COMMENT_LEN = 2000;
/** Links per comment. A link or two is a citation; five is an advert. */
export const MAX_COMMENT_LINKS = 2;

/** Body `value` for POST /thumbs → the stored vote. null clears the vote. */
export function parseVote(raw: unknown): 1 | -1 | null {
  if (raw === null || raw === undefined) return null;
  if (raw === "up") return 1;
  if (raw === "down") return -1;
  throw new Error("value must be up, down or null");
}

/** Comment text before persisting: trimmed, bounded, at most a couple of links,
 *  no long repeated-character runs — the review rules relaxed for a conversation
 *  (2000 chars, not the review cap of 500).
 *
 *  Reviews banned URLs outright. Comments must NOT: on a plugin thread "known
 *  issue, see github.com/x/y/issues/3" is the single most useful thing anyone
 *  can leave, and banning it would train people not to bother. Link SPAM is the
 *  actual worry, so cap the count instead; the llama-guard classifier in the
 *  route is the second line. The repeated-character run is 20+, not 10+, so an
 *  ASCII rule (`----------`) or an ellipsis is not "spam". */
export function validateCommentText(raw: unknown): string {
  // Two different failures, two different messages: a number is not an empty
  // comment, and saying so would be a wrong cause in a user-facing string
  // (CLAUDE.md → "Never write misleading error messages").
  if (typeof raw !== "string") throw new Error("comment must be text");
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("comment is empty");
  if (trimmed.length > MAX_COMMENT_LEN) {
    throw new Error(`comment too long (${trimmed.length} > ${MAX_COMMENT_LEN})`);
  }
  if ((trimmed.match(/https?:\/\//gi) ?? []).length > MAX_COMMENT_LINKS) {
    throw new Error(`too many links (at most ${MAX_COMMENT_LINKS})`);
  }
  if (/(.)\1{19,}/.test(trimmed)) throw new Error("comment appears to be spam");
  return trimmed;
}
