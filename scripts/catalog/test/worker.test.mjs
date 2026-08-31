import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerClient } from "../lib/worker.mjs";

test("upsert batches at 500 and sums the counts", async () => {
  const calls = [];
  const client = createWorkerClient({ host: "https://w.test", token: "t", fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ ok: true, upserted: JSON.parse(init.body).entries.length }), { status: 200 });
  }});
  const entries = Array.from({ length: 1201 }, (_, i) => ({ id: `e${i}`, catalog: { itemType: "plugin" } }));
  const n = await client.upsert("docker", "run-1", entries);
  assert.deepEqual(n, { upserted: 1201, unchanged: 0 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.entries.length, 500);
  assert.equal(calls[2].body.entries.length, 201);
  assert.equal(calls[0].headers["X-Catalog-Token"], "t");
  assert.equal(calls[0].url, "https://w.test/admin/catalog/upsert");
});

test("a non-2xx from the Worker throws with the body", async () => {
  const client = createWorkerClient({ host: "https://w.test", token: "t", fetchImpl: async () => new Response("unknown source", { status: 400 }) });
  await assert.rejects(() => client.finish("docker", "r", []), /400.*unknown source/);
});
