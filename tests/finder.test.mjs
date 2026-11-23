import assert from "node:assert/strict";
import test from "node:test";
import { FinderPage, japanNow, validateConditions, allergenLabel } from "../site/finder.js";
import { shops } from "../site/shop-registry.js";
import { validateShops } from "../scripts/shops.mjs";

const now = () => new Date("2026-11-14T09:00:00Z");
const valid = (changes = {}) => ({ date: "2026-12-18", time: "19:00", partySize: 12, course: "wanted", budgetPerPerson: 5000, avoid: ["えび"], note: "相談用", ...changes });
const candidate = (changes = {}) => ({ shopId: "akari", status: "available", remaining: 14, durationMinutes: 120, seatOnly: true,
  courseId: "winter", courseName: "冬の炉端コース", priceText: "1人5,000円 / 12名60,000円", avoidResult: "えび：記載なし。安全の保証ではありません。", summary: "店の回答を確認", ...changes });
function arrange() {
  const visited = [];
  const page = new FinderPage(shops, { now, navigate: url => visited.push(url) });
  assert.equal(page.setConditions(valid()).ok, true);
  return { page, visited };
}

test("today and weekday use Japan time and refresh across midnight", () => {
  let clock = new Date("2026-11-14T14:59:00Z");
  const page = new FinderPage(shops, { now: () => clock });
  assert.equal(page.getState().today, "2026-11-14");
  assert.match(page.getState().todayLabel, /土/);
  clock = new Date("2026-11-14T15:01:00Z");
  assert.equal(page.getState().today, "2026-11-15");
  assert.equal(japanNow(clock).currentTime, "00:01");
});

test("ordinary seat-only and banquet conditions share the same validation", () => {
  const { page } = arrange();
  assert.equal(page.setConditions({ date: "2026-11-14", time: "19:00", partySize: 2, course: "none" }).ok, true);
  assert.equal(page.getState().conditions.course, "none");
  assert.equal(page.setConditions({ date: "2026-12-18", time: "19:00", partySize: 12 }).ok, true);
  assert.equal(page.getState().conditions.course, "any");
  assert.equal(page.getState().version, 3);
});

test("invalid conditions refuse atomically and preserve results", () => {
  const { page } = arrange();
  page.showCandidates({ candidates: [candidate()], expectedVersion: page.version });
  const before = page.getState();
  for (const change of [
    { date: "2026-02-30" }, { date: "2026-11-13" }, { date: "2026-11-14", time: "17:59" }, { time: "25:00" },
    { partySize: 0 }, { partySize: 201 }, { partySize: 1.5 }, { partySize: "12" }, { course: "invalid" },
    { budgetPerPerson: 0 }, { budgetPerPerson: 1000001 }, { budgetPerPerson: 1.5 }, { avoid: "えび" },
    { avoid: ["a", "b", "c", "d", "e", "f"] }, { avoid: ["x".repeat(21)] }, { avoid: ["person@example.com"] },
    { avoid: ["09012345678"] }, { avoid: ["sk-secret"] }, { note: "x".repeat(501) }, { apiKey: "secret" },
  ]) {
    const result = page.setConditions(valid(change));
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.deepEqual(page.getState(), before);
  }
});

test("allergen aliases normalize and deduplicate; eight items plus five free words", () => {
  const result = validateConditions(valid({ avoid: ["えび", "shrimp", "卵", "milk", "くるみ", "かに", "小麦", "そば", "落花生", "しいたけ", "いか", "たこ", "鶏肉"] }), now());
  assert.equal(result.ok, true);
  assert.deepEqual(result.conditions.avoid.slice(0, 3), ["shrimp", "egg", "milk"]);
  const edge = validateConditions(valid({ avoid: ["constructor", "__proto__"] }), now());
  assert.equal(edge.ok, true);
  assert.deepEqual(edge.conditions.avoid.map(allergenLabel), ["constructor", "__proto__"]);
  assert.equal(validateConditions(valid({ partySize: 200 }), now()).ok, true);
});

test("read actions return copies and area filters use the registry", () => {
  const { page } = arrange();
  const state = page.getState(); state.conditions.avoid.push("secret");
  const list = page.listShops(); list[0].pageUrl = "https://evil.example";
  assert.deepEqual(page.getState().conditions.avoid, ["shrimp"]);
  assert.equal(page.listShops({ area: "Shinjuku" }).length, 1);
  assert.equal(page.listShops({ area: "Tokyo" }).length, 2);
  assert.deepEqual(page.listShops({ cuisine: "Cantonese", area: "Yokohama" }).map(shop => shop.id), ["kanton-ryu"]);
  assert.deepEqual(page.listShops({ cuisine: "Italian" }).map(shop => shop.id), ["trattoria-sole"]);
  assert.deepEqual(page.listShops({ cuisine: "Japanese", area: "Yokohama" }), []);
  assert.deepEqual(page.listShops({ area: "存在しない" }), []);
  assert.equal(page.listShops()[0].pageUrl, shops[0].pageUrl);
});

test("no-preference spellings are not searched as literal cuisines or places", () => {
  const { page } = arrange();
  for (const value of ["", "指定なし", "指定無し", "未指定", "おまかせ", "どこでも", "何でも", "Any", "none"]) {
    assert.equal(page.listShops({ area: value, cuisine: value }).length, shops.length, value);
    assert.deepEqual(page.listShops({ area: value, cuisine: "Cantonese" }).map(shop => shop.id), ["kanton-ryu"]);
  }
  assert.deepEqual(page.listShops({ area: "存在しない", cuisine: "指定なし" }), []);
});

test("manual partial changes invalidate old results and pending navigation", () => {
  const { page, visited } = arrange();
  page.showCandidates({ candidates: [candidate()], expectedVersion: page.version });
  const old = page.version;
  const proposal = { shopId: "akari", courseId: "winter", expectedVersion: old };
  assert.equal(page.checkOpenShop(proposal).ok, true);
  page.editConditions({ ...page.conditions, time: "" });
  assert.deepEqual(page.candidates, []);
  assert.equal(page.getState().valid, false);
  assert.equal(page.openShopPage(proposal).ok, false);
  assert.deepEqual(visited, []);
  assert.equal(page.showCandidates({ candidates: [candidate()], expectedVersion: old }).ok, false);
});

test("invalid, duplicate and stale comparisons leave the whole state unchanged", () => {
  const { page } = arrange();
  for (const list of [
    [candidate({ shopId: "fake" })], [candidate(), candidate()], [candidate({ status: "booked" })],
    [candidate({ remaining: -1 })], [candidate({ durationMinutes: "120" })], [candidate({ summary: "" })],
    [candidate({ courseId: "https://evil" })], [candidate({ html: "<script>" })], [candidate({ seatOnly: "yes" })],
  ]) {
    const before = page.getState();
    assert.equal(page.showCandidates({ candidates: list, expectedVersion: page.version }).ok, false);
    assert.deepEqual(page.getState(), before);
  }
  assert.equal(page.showCandidates({ candidates: [candidate()] }).ok, false);
});

test("declined, full and unknown are explicit comparison states", () => {
  const { page } = arrange();
  assert.equal(page.showCandidates({ candidates: [candidate({ status: "declined" }), candidate({ shopId: "trattoria-sole", status: "full" }), candidate({ shopId: "kanton-ryu", status: "unknown" })], expectedVersion: page.version }).count, 3);
  assert.deepEqual(page.candidates.map(c => c.status), ["declined", "full", "unknown"]);
  page.clearCandidates(); assert.deepEqual(page.candidates, []);
});

test("handoff uses only validated, allowed conditions in the URL fragment", () => {
  const { page, visited } = arrange();
  page.setConditions(valid({ note: "person@example.com 09012345678 sk-private" }));
  page.showCandidates({ candidates: [candidate()], expectedVersion: page.version });
  const result = page.openShopPage({ shopId: "akari", courseId: "winter", expectedVersion: page.version });
  assert.equal(result.ok, true);
  assert.deepEqual(visited, [result.url]);
  const url = new URL(result.url);
  assert.equal(url.search, "");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.hash.slice(1))), {
    aw: "v1", date: "2026-12-18", time: "19:00", people: "12", course: "wanted", budget: "5000", avoid: "shrimp", course_id: "winter",
  });
  assert.doesNotMatch(result.url, /person|090|private|note|key|provider/);
});

test("seat-only handoff omits course IDs, optional fields and notes", () => {
  const { page } = arrange();
  page.setConditions({ date: "2026-11-14", time: "19:00", partySize: 2, course: "none" });
  const result = page.checkOpenShop({ shopId: "trattoria-sole", expectedVersion: page.version });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(result.url).hash.slice(1))), {
    aw: "v1", date: "2026-11-14", time: "19:00", people: "2", course: "none",
  });
  assert.equal(page.openShopPage({ shopId: "akari", courseId: "invented", expectedVersion: page.version }).ok, false);
});

test("unknown shop, guessed course, stale version and elapsed time block navigation", () => {
  const { page, visited } = arrange();
  for (const args of [
    { shopId: "fake", expectedVersion: page.version }, { shopId: "akari" },
    { shopId: "akari", expectedVersion: page.version - 1 }, { shopId: "akari", courseId: "fake", expectedVersion: page.version },
  ]) assert.equal(page.openShopPage(args).ok, false);
  page.now = () => new Date("2026-12-19T00:00:00Z");
  assert.equal(page.openShopPage({ shopId: "akari", expectedVersion: page.version }).ok, false);
  assert.deepEqual(visited, []);
});

test("shop registry rejects insecure URLs, credentials and tool-name collisions", () => {
  const config = { version: 1, shops: shops.map(({ networkTool, ...shop }) => shop) };
  assert.equal(validateShops(config)[1].networkTool, "s_trattoria_sole_agent_reservation_concierge");
  const loopback = { ...config, shops: [{ ...config.shops[0], pageUrl: "http://127.0.0.1:3000/s/akari/" }] };
  assert.throws(() => validateShops(loopback, { production: true }), /HTTPS/);
  for (const changes of [
    { pageUrl: "http://shops.example/reserve" }, { networkUrl: "https://user:secret@shops.example/network" },
    { networkUrl: "http://127.0.0.1:3000/network?key=secret" }, { pageUrl: "http://127.0.0.1:3000/reserve#secret" },
    { networkUrl: shops[1].networkUrl }, { id: shops[1].id },
  ]) assert.throws(() => validateShops({ ...config, shops: [{ ...config.shops[0], ...changes }, ...config.shops.slice(1)] }));
});

test("shop and reservation visits use different pages and only verified course IDs", () => {
  const page = new FinderPage(shops, { now });
  page.setConditions(valid());
  page.showCandidates({ expectedVersion: page.version, candidates: [candidate()] });
  const home = new URL(page.framedShopUrl("akari", "shop").url);
  const reserve = new URL(page.framedShopUrl("akari", "reserve", "winter").url);
  assert.equal(home.pathname, "/s/akari/");
  assert.equal(reserve.pathname, "/s/akari/reserve");
  assert.equal(new URLSearchParams(reserve.hash.slice(1)).get("course_id"), "winter");
  assert.equal(new URLSearchParams(new URL(page.framedShopUrl("akari", "reserve", "guessed").url).hash.slice(1)).has("course_id"), false);
  assert.equal(new URLSearchParams(home.hash.slice(1)).has("note"), false);
});
