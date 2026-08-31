// Client for the Worker's ingest routes (worker/src/catalog/routes.ts).
export function createWorkerClient({ host, token, fetchImpl = fetch }) {
  const headers = { "Content-Type": "application/json", "X-Catalog-Token": token };
  async function call(method, path, body) {
    const res = await fetchImpl(`${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  return {
    // Commits the catalog already has on file, keyed by id — the input to the
    // "only re-read what changed" skip in every source.
    shas: (source) => call("GET", `/admin/catalog/shas?source=${encodeURIComponent(source)}`).then((r) => r.shas ?? {}),
    async upsert(source, runId, entries) {
      const total = { upserted: 0, unchanged: 0 };
      for (let i = 0; i < entries.length; i += 500) {
        const r = await call("POST", "/admin/catalog/upsert", { source, run_id: runId, entries: entries.slice(i, i + 500) });
        total.upserted += r.upserted ?? 0;
        total.unchanged += r.unchanged ?? 0;
      }
      return total;
    },
    // `retire` is the explicit list of ids to delist — computed by build.mjs, never inferred
    // by the Worker. Always called, even with an empty list: that is what records the run.
    finish: (source, runId, retire, note, allowMassRetire) =>
      call("POST", "/admin/catalog/finish", { source, run_id: runId, retire, ...(note ? { note } : {}), ...(allowMassRetire ? { allow_mass_retire: true } : {}) }),
  };
}
