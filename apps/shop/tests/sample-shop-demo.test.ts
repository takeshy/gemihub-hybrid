import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Store } from "../server/store.ts";

test("sample shop creation and storefront access stay within one browser session", async t => {
  const { createSampleShops } = await import(new URL("../../../scripts/sample-shops.mjs", import.meta.url).href);
  const store = new Store(":memory:");
  const origin = "https://hybrid.gemihub.net";
  const invite = "test-only-shop-invitation-00000000";
  const { route } = createSampleShops(store, origin, { invite, until: new Date(Date.now() + 7200000).toISOString() });
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url || "/", origin).pathname).then((result: string) => {
      if (result !== "handled") res.end(result);
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const startSession = (token: string, requestOrigin = origin) => fetch(`${base}/api/judge/session`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin },
    body: JSON.stringify({ invite: token }),
  });
  const guest = await fetch(`${base}/api/demo-shop`);
  assert.deepEqual(await guest.json(), { authenticated: false, shop: null, draft: null });
  assert.equal(guest.headers.get("set-cookie"), null);
  assert.equal((await startSession("invalid-invite")).status, 403);
  assert.equal((await startSession(invite, "https://example.org")).status, 403);
  const session = async () => {
    const response = await startSession(invite);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie || "", /^gemihub_judge=[a-f0-9]{48}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    return cookie!.split(";")[0];
  };
  const owner = await session(), other = await session();
  const draft = { name: "Willow Café", description: "Toast and coffee.", opensAt: "10:00", closesAt: "18:00" };
  const publish = (requestOrigin = origin, body = draft, cookie = owner) => fetch(`${base}/api/demo-shop`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: cookie },
    body: JSON.stringify(body),
  });
  assert.equal((await publish(origin, draft, "")).status, 401);
  assert.equal((await publish("https://example.org")).status, 403);
  assert.equal((await publish(origin, { ...draft, closesAt: "09:00" })).status, 400);
  const created = await publish();
  assert.equal(created.status, 201);
  const { shop } = await created.json();
  assert.equal(shop.hours, "10:00 – 18:00");
  assert.deepEqual((await store.shop(shop.id))?.published?.hours,
    { start: "10:00", end: "18:00", closedWeekdays: [], holidays: [] });
  const updatedDraft = { ...draft, opensAt: "11:00" };
  const edited = await publish(origin, updatedDraft);
  assert.equal(edited.status, 200);
  const saved = await edited.json();
  assert.equal(saved.shop.id, shop.id);
  assert.equal(saved.shop.hours, "11:00 – 18:00");
  assert.equal((await store.shop(shop.id))?.published?.hours.start, "11:00");
  const ownerState = await fetch(`${base}/api/demo-shop`, { headers: { Cookie: owner } });
  assert.deepEqual(await ownerState.json(), { authenticated: true, ...saved });
  const otherState = await fetch(`${base}/api/demo-shop`, { headers: { Cookie: other } });
  assert.deepEqual(await otherState.json(), { authenticated: true, shop: null, draft: null });
  for (const path of [`/s/${shop.id}/`, `/s/${shop.id}/agent/facts.json`, `/api/public/${shop.id}`]) {
    const unauthenticated = await fetch(base + path);
    assert.equal(unauthenticated.status, 404, path);
    const unauthorised = await fetch(base + path, { headers: { Cookie: other } });
    assert.equal(unauthorised.status, 404, path);
    const authorised = await fetch(base + path, { headers: { Cookie: owner } });
    assert.equal(await authorised.text(), "private", path);
  }
  const booking = await fetch(`${base}/api/public/${shop.id}/bookings`, {
    method: "POST", headers: { Cookie: owner, Origin: origin },
  });
  assert.equal(booking.status, 405);
});
