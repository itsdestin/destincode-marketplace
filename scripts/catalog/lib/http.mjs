// Tiny fetch helpers — no deps, like scripts/sync.js. GitHub calls are
// authenticated (60/hr unauthenticated is not survivable) and rate-limit aware:
// below 200 remaining we stop rather than get banned. The budget is 1,000/hr per
// repository for Actions' GITHUB_TOKEN, so hitting this is a signal that the
// "only re-read what changed" skip has stopped working — not a reason to raise it.
export class RateLimited extends Error {}

async function check(res, url) {
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res;
}

export async function getJson(url, { headers = {} } = {}) {
  return (await check(await fetch(url, { headers }), url)).json();
}
export async function getText(url, { headers = {} } = {}) {
  return (await check(await fetch(url, { headers }), url)).text();
}
export async function postJson(url, body, { headers = {} } = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const GH_API = "https://api.github.com";
export const github = Object.assign(async function github(pathOrUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required for GitHub API calls");
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GH_API}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "wecoded-catalog" } });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1000");
  github.remaining = remaining;
  if (res.status === 403 && remaining === 0) throw new RateLimited(`GitHub rate limit hit (resets ${res.headers.get("x-ratelimit-reset")})`);
  if (remaining < 200) throw new RateLimited(`GitHub rate limit nearly exhausted (${remaining} left)`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}, { remaining: Infinity });

export function githubRaw(owner, repo, sha, path) {
  return getText(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`);
}
