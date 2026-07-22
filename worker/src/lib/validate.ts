import { badRequest } from "./errors";

// Normalizes and validates a plugin/theme id from request input. Trims
// surrounding whitespace, rejects empty or over-128-char values with a 400,
// and returns the cleaned id. Centralizes the `!id || id.length > 128` check
// that every id-taking route (ratings, installs, themes) previously copied.
// `label` names the field in the error message ("plugin_id", "theme id").
// Trimming param sources (not just JSON bodies) is intentional normalization —
// an id with stray whitespace would never match a stored row anyway.
export function validateId(raw: string | undefined | null, label = "plugin_id"): string {
  const id = raw?.trim();
  if (!id || id.length > 128) throw badRequest(`invalid ${label}`);
  return id;
}
