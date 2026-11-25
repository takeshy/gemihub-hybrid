import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";

test("background work started inside a request runs outside the request's released locks", async t => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  // A request's lease, released when the request finishes, as the Firestore lock does.
  const released = { ref: {} as never, owner: "request", expiresAt: Date.now() + 60000, active: false, lost: false };
  const leases = (store as unknown as { leases: { run: <T>(value: unknown[], fn: () => T) => T } }).leases;
  await assert.rejects(leases.run([released], () => store.put("note", "a", { ok: true })), /expired|有効期限/);
  await leases.run([released], () => store.detached(() => store.put("note", "b", { ok: true })));
  assert.deepEqual(await store.get("note", "b"), { ok: true });
});
