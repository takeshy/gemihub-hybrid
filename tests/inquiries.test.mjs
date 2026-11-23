import assert from "node:assert/strict";
import test from "node:test";
import { FinderPage } from "../site/finder.js";
import { shops } from "../site/shop-registry.js";
import { ShopInquiries, installInquiryPolicy } from "../site/inquiries.js";

function arrange(review = async () => true, registry = shops, message = "ジャンルと場所は指定なし") {
  const page = new FinderPage(registry, { now: () => new Date("2026-11-14T09:00:00Z") });
  page.setConditions({ date: "2026-12-18", time: "19:00", partySize: 12 });
  const inquiries = new ShopInquiries(() => page, review, () => message);
  return { page, inquiries, confirm: (extra = {}) => inquiries.confirm({ cuisine: "", area: "", expectedVersion: page.version, ...extra }) };
}

const registryOf = count => Array.from({ length: count }, (_, index) => ({
  ...shops[index % shops.length], id: `shop-${index}`, name: `登録店${index + 1}`,
  networkUrl: `http://127.0.0.1:3000/s/shop-${index}/agent/reservation_concierge`,
}));

test("fewer than 15 candidates proceed without asking for genre or place", async () => {
  let shown = false;
  const { inquiries, confirm } = arrange(async () => { shown = true; return true; }, shops, "明日の18時に2人、席だけで探して");
  const result = await confirm();
  assert.equal(result.approved, true);
  assert.equal(result.count, 3);
  assert.equal(shown, true);
  assert.deepEqual(inquiries.preferences, { cuisine: null, area: null });
});

test("14 candidates start in batches but 15 ask only for missing preferences", async () => {
  for (const count of [14, 15]) {
    let shown = false;
    const { inquiries, confirm } = arrange(async () => { shown = true; return true; }, registryOf(count), "明日の18時に2人");
    const result = await confirm();
    assert.equal(shown, count === 14);
    if (count === 14) {
      assert.equal(result.approved, true);
      assert.equal(result.count, 4);
      assert.equal(result.totalCount, 14);
    } else {
      assert.equal(result.needsPreferences, true);
      assert.equal(result.count, 15);
      assert.deepEqual(result.missingPreferences, ["cuisine", "area"]);
      assert.equal(inquiries.activePlan(), null);
      inquiries.getUserMessage = () => "おまかせ・どこでも";
      assert.equal((await confirm()).approved, true);
    }
  }
});

test("the threshold uses filtered candidates and does not ask the other preference below 15", async () => {
  const { inquiries, confirm } = arrange(undefined, registryOf(30), "Cantoneseで探して");
  const filtered = await confirm({ cuisine: "Cantonese" });
  assert.equal(filtered.approved, true);
  assert.equal(filtered.totalCount, 10);
  assert.equal(filtered.count, 4);
  assert.deepEqual(inquiries.preferences, { cuisine: "Cantonese", area: null });
  const { confirm: large } = arrange(undefined, registryOf(45), "Cantoneseで探して");
  const result = await large({ cuisine: "Cantonese" });
  assert.equal(result.needsPreferences, true);
  assert.deepEqual(result.missingPreferences, ["area"]);
});

test("literal unspecified tool arguments count all registered shops instead of zero", async () => {
  const { confirm } = arrange(undefined, shops, "ジャンル・場所どちらも指定なし");
  const result = await confirm({ cuisine: "指定なし", area: "指定なし" });
  assert.equal(result.approved, true);
  assert.equal(result.totalCount, shops.length);
  assert.deepEqual(result.shops.map(shop => shop.id), shops.map(shop => shop.id));
  await confirm({ cuisine: "Cantonese", area: "Nakazakicho" });
  assert.equal((await confirm({ cuisine: "おまかせ", area: "指定なし" })).count, shops.length);
});

test("continuation visits every candidate in groups of four with exact batch scope", async () => {
  const registry = registryOf(14);
  const plans = [];
  const { page, inquiries, confirm } = arrange(async plan => { plans.push(plan); return true; }, registry, "明日の18時に2人");
  const seen = [];
  for (const offset of [0, 4, 8, 12]) {
    const result = await confirm({ offset });
    assert.equal(result.approved, true);
    assert.equal(result.totalCount, 14);
    assert.equal(result.count, Math.min(4, 14 - offset));
    assert.equal(result.nextOffset, offset === 12 ? null : offset + 4);
    assert.equal(result.hasMore, offset !== 12);
    assert.equal(inquiries.batchState().offset, offset);
    for (const shop of registry) {
      assert.equal(inquiries.canContactNetwork(shop.networkUrl), result.shops.some(item => item.id === shop.id));
    }
    seen.push(...result.shops.map(shop => shop.id));
    assert.equal(page.candidates.length, offset ? 1 : 0);
    page.showCandidates({ candidates: [{ shopId: registry[0].id, status: "unknown", summary: "確認済みの結果" }], expectedVersion: page.version });
  }
  assert.deepEqual(seen, registry.map(shop => shop.id));
  assert.equal(plans.length, 4);
  assert.equal((await confirm({ offset: 16 })).ok, false);
});

test("a continuation cannot skip batches or reuse a changed search", async () => {
  for (const change of ["skip", "conditions", "preferences", "reset"]) {
    const { page, inquiries, confirm } = arrange(undefined, registryOf(14));
    assert.equal((await confirm()).approved, true);
    if (change === "conditions") page.setConditions({ ...page.conditions, partySize: 2 });
    if (change === "reset") inquiries.reset();
    assert.equal((await confirm({ offset: change === "skip" ? 8 : 4, ...(change === "preferences" ? { cuisine: "Cantonese" } : {}) })).ok, false);
    assert.equal(inquiries.activePlan(), null);
  }
});

test("the count and exact targets come from parent metadata before any connection", async () => {
  let shown;
  const { inquiries, confirm } = arrange(async plan => { shown = plan; return true; });
  assert.equal(inquiries.canContactNetwork(shops[2].networkUrl), false);
  assert.equal(inquiries.decision({ kind: "network", peerOrigin: "127.0.0.1:3000" }), "decline");
  const result = await confirm({ cuisine: "Cantonese", area: "Nakazakicho" });
  assert.equal(result.approved, true);
  assert.equal(result.count, 1);
  assert.deepEqual(shown.shops.map(shop => shop.id), ["kanton-ryu"]);
  assert.equal(inquiries.canContactNetwork(shops[2].networkUrl), true);
  assert.equal(inquiries.canContactNetwork(shops[0].networkUrl), false);
});

test("one decision covers all selected shops, not a separate card per shop", async () => {
  let decisions = 0;
  const { inquiries, confirm } = arrange(async () => { decisions++; return true; });
  const result = await confirm();
  assert.equal(result.count, 3);
  for (const shop of shops) {
    assert.equal(inquiries.decision({ kind: "network", peerOrigin: new URL(shop.networkUrl).host }), "allow");
    assert.equal(inquiries.canContactNetwork(shop.networkUrl), true);
  }
  assert.equal(decisions, 1);
  assert.equal(inquiries.decision({ kind: "mcp", peerOrigin: "other.example" }), "decline");
});

test("declining, stale dates and missing preferences make no approved plan", async () => {
  const { inquiries, page, confirm } = arrange(async () => false);
  assert.equal((await confirm()).approved, false);
  assert.equal(inquiries.activePlan(), null);
  assert.equal((await inquiries.confirm({ expectedVersion: page.version })).ok, false);
  assert.equal((await confirm({ expectedVersion: 0 })).ok, false);
  page.now = () => new Date("2026-12-19");
  assert.equal((await confirm()).ok, false);
});

test("zero matches do not show a confirmation or silently broaden the search", async () => {
  let shown = false;
  const { confirm } = arrange(async () => { shown = true; return true; });
  const result = await confirm({ cuisine: "Cantonese", area: "Tokyo" });
  assert.equal(result.count, 0);
  assert.equal(shown, false);
});

test("condition changes during confirmation invalidate acceptance", async () => {
  let finish;
  const { page, inquiries, confirm } = arrange(() => new Promise(resolve => { finish = resolve; }));
  const pending = confirm();
  page.setConditions({ ...page.conditions, partySize: 2 });
  finish(true);
  assert.equal((await pending).ok, false);
  assert.equal(inquiries.activePlan(), null);
});

test("new conditions and new conversations cannot reuse the previous approval", async () => {
  const { page, inquiries, confirm } = arrange();
  await confirm();
  page.setConditions({ ...page.conditions, partySize: 2 });
  assert.equal(inquiries.activePlan(), null);
  await confirm({ cuisine: "Cantonese", area: "Nakazakicho" });
  inquiries.reset();
  assert.equal(inquiries.activePlan(), null);
  assert.deepEqual(inquiries.preferences, { cuisine: null, area: null });
});

test("blank filters cannot silently widen previously specified preferences", async () => {
  const { inquiries, confirm } = arrange();
  await confirm({ cuisine: "Cantonese", area: "Nakazakicho" });
  inquiries.getUserMessage = () => "日時だけ変えてください";
  assert.equal((await confirm()).count, 1);
  assert.deepEqual(inquiries.preferences, { cuisine: "Cantonese", area: "Nakazakicho" });
  inquiries.getUserMessage = () => "ジャンルと場所は指定なし";
  assert.equal((await confirm()).count, 3);
});

test("resolver guards keep scheme, port and network identity scoped to the confirmed plan", async () => {
  const { inquiries, confirm } = arrange();
  const calls = [];
  const engine = { consent: new Map([["127.0.0.1:3000", "always"]]),
    resolveRemote: async url => calls.push(url), resolveMcp: async ref => calls.push(ref) };
  installInquiryPolicy(engine, inquiries);
  assert.equal(engine.consent.size, 0);
  assert.throws(() => engine.resolveRemote(shops[2].networkUrl), /先に/);
  await confirm({ cuisine: "Cantonese", area: "Nakazakicho" });
  assert.throws(() => engine.resolveRemote(shops[0].networkUrl), /先に/);
  const changedScheme = new URL(shops[2].networkUrl);
  changedScheme.protocol = changedScheme.protocol === "https:" ? "http:" : "https:";
  assert.throws(() => engine.resolveRemote(changedScheme.href), /先に/);
  assert.throws(() => engine.resolveMcp({ url: "https://127.0.0.1:3000/mcp" }), /含まれない/);
  assert.throws(() => engine.resolveMcp({ url: "http://127.0.0.1:3001/mcp" }), /含まれない/);
  assert.equal(calls.length, 0);
  await engine.resolveRemote(shops[2].networkUrl);
  await engine.resolveMcp({ url: new URL("mcp", shops[2].networkUrl).href });
  assert.equal(calls.length, 2);
});
