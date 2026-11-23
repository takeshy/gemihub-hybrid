import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { allowDemoShoppers } from "../server/auth.ts";
import { Store } from "../server/store.ts";
import { request as httpRequest } from "node:http";
import { shopSchema, bookingMenuName, asRestaurant, takesBookings, canPublishShop, sample, type Booking, type ShopConfig } from "../server/domain.ts";
import { updateLiveValue } from "../server/live-settings.ts";
import { clientAddress, parentSite } from "../server/agentic.ts";
import { defaultSeating, halfHours } from "../shared/seating.ts";
import { canSeat, durationFor, seatAvailability, seatBoard, seatOverflow, seatsFor } from "../server/seats.ts";
import { checkAvailability, findMenuItems, matchAvoid, shopInfo } from "../server/restaurant-mcp.ts";
import { exportColumns } from "../server/data-export.ts";
import { nextFriday, restaurantDemoShops, seedRestaurantDemo } from "../scripts/seed-restaurant-demo.ts";

process.env.DEMO_MODE = "true";
allowDemoShoppers();

// Monday 2030-01-07, 09:00 in Japan.
const now = new Date("2030-01-07T00:00:00Z");
const day = "2030-01-11";
const akari = () => structuredClone(restaurantDemoShops("2030-01-11")[0].config);
const ryu = () => structuredClone(restaurantDemoShops("2030-01-11")[2].config);
const at = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString();
const party = (date: string, time: string, partySize: number, minutes: number, status: Booking["status"] = "active") =>
  ({ status, partySize, start: at(date, time), end: new Date(Date.parse(at(date, time)) + minutes * 60000).toISOString() });
const slotAt = (slots: ReturnType<typeof seatAvailability>, date: string, time: string) => slots.find(slot => slot.start === at(date, time));

test("a restaurant needs seat settings and ingredients on every shown menu item", () => {
  const config = akari();
  assert.equal(shopSchema.safeParse(config).success, true);
  assert.equal(shopSchema.safeParse({ ...config, seating: undefined }).success, false);
  const noIngredients = structuredClone(config);
  delete noIngredients.menus[3].ingredients;
  assert.equal(shopSchema.safeParse(noIngredients).success, false, "a dish needs ingredients too, not only courses");
  noIngredients.menus[3].active = false;
  assert.equal(shopSchema.safeParse(noIngredients).success, true, "a hidden item is not checked");
  const courseOnly = ryu();
  courseOnly.menus = courseOnly.menus.filter(menu => menu.kind !== "course");
  assert.equal(shopSchema.safeParse(courseOnly).success, false, "course-only reservations need a course");
  const duplicate = akari();
  duplicate.seating!.overrides.push({ date: "2030-01-11", reservableSeats: 10 });
  assert.equal(shopSchema.safeParse(duplicate).success, false);
  const range = akari();
  range.menus[0].minPeople = 31;
  assert.equal(shopSchema.safeParse(range).success, false);
});

test("the length of stay follows the course, then the party size", () => {
  const config = akari();
  assert.equal(durationFor(config, 2), 90);
  assert.equal(durationFor(config, 6), 90);
  assert.equal(durationFor(config, 7), 120, "seven guests are a large party");
  config.menus[0].courseMinutes = 150;
  assert.equal(durationFor(config, 2, "winter-robata"), 150, "a course's own time wins");
  assert.equal(durationFor(config, 2, "seafood-robata"), 90);
});

test("seats left count every overlapping party at its busiest moment", () => {
  const config = akari();
  assert.equal(seatsFor(config, "2030-01-10"), 24);
  assert.equal(seatsFor(config, day), 20, "the date's own number replaces the normal one");
  // Two parties that never sit together count once each, not together.
  const bookings = [party("2030-01-10", "18:00", 10, 60), party("2030-01-10", "19:00", 10, 60), party("2030-01-10", "19:00", 4, 90, "cancelled")];
  const slots = seatAvailability(config, bookings, "2030-01-10", 12, undefined, now);
  assert.equal(slotAt(slots, "2030-01-10", "18:00")!.booked, 10, "18:00-20:00 meets each party of ten separately");
  assert.equal(slotAt(slots, "2030-01-10", "18:00")!.remaining, 14);
  assert.equal(slotAt(slots, "2030-01-10", "18:00")!.fits, true);
  assert.equal(slotAt(slots, "2030-01-10", "20:00")!.booked, 0, "a party that has left frees its seats");
  // A short stay and a long one overlap for as long as the longer one lasts.
  const mixed = [party("2030-01-10", "18:00", 2, 90), party("2030-01-10", "19:00", 12, 120)];
  const two = seatAvailability(config, mixed, "2030-01-10", 2, undefined, now);
  assert.equal(slotAt(two, "2030-01-10", "19:00")!.booked, 14, "the pair is still seated at 19:00");
  assert.equal(slotAt(two, "2030-01-10", "19:30")!.booked, 12);
  assert.equal(slotAt(two, "2030-01-10", "17:00")!.booked, 2, "17:00-18:30 ends before the banquet starts");
});

test("times that pass closing, the lead time or the booking window are not offered", () => {
  const config = akari();
  config.hours.end = "22:00";
  const large = seatAvailability(config, [], "2030-01-10", 8, undefined, now).map(slot => slot.start);
  assert.equal(large.at(-1), at("2030-01-10", "20:00"), "120 minutes from 20:30 would pass closing");
  const pair = seatAvailability(config, [], "2030-01-10", 2, undefined, now).map(slot => slot.start);
  assert.equal(pair.at(-1), at("2030-01-10", "20:30"));
  config.rules.leadMinutes = 60;
  const evening = new Date("2030-01-07T09:30:00Z"); // 18:30
  assert.equal(seatAvailability(config, [], "2030-01-07", 2, undefined, evening)[0].start, at("2030-01-07", "19:30"));
  config.rules.sameDay = false;
  assert.deepEqual(seatAvailability(config, [], "2030-01-07", 2, undefined, now), []);
  assert.deepEqual(seatAvailability(config, [], "2031-01-07", 2, undefined, now), []);
  config.hours.closedWeekdays = [4];
  assert.equal(canSeat(config, [], "2030-01-10", at("2030-01-10", "19:00"), 2, undefined, now).ok, false);
});

test("canSeat refuses with the reason a guest can act on", () => {
  const config = akari();
  const start = at(day, "19:00");
  const ok = canSeat(config, [party(day, "19:00", 6, 120)], day, start, 12, "winter-robata", now);
  assert.deepEqual(ok, { ok: true, durationMinutes: 120, end: at(day, "21:00") });
  const full = canSeat(config, [party(day, "19:00", 9, 120)], day, start, 12, undefined, now);
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.problem, "full");
  const problem = (result: ReturnType<typeof canSeat>) => result.ok ? "" : result.problem;
  assert.equal(problem(canSeat(config, [], day, at(day, "19:10"), 2, undefined, now)), "time");
  assert.equal(problem(canSeat(config, [], day, start, 25, undefined, now)), "party_size");
  assert.equal(problem(canSeat(config, [], day, start, 2, "ebi-kushi", now)), "course", "a dish is not a course");
  assert.equal(problem(canSeat(config, [], day, start, 1, "winter-robata", now)), "course_people");
  const courseOnly = ryu();
  assert.equal(problem(canSeat(courseOnly, [], day, start, 4, undefined, now)), "seat_only");
  assert.equal(canSeat(courseOnly, [], day, start, 4, "veggie-table", now).ok, true);
  assert.equal(problem(canSeat(courseOnly, [], day, start, 17, "round-table", now)), "party_size");
});

test("cutting seats below what is reserved keeps the reservations and reports the overflow", () => {
  const config = akari();
  const bookings = [party(day, "19:00", 12, 120), party(day, "19:30", 6, 90)];
  config.seating!.overrides = [{ date: day, reservableSeats: 10 }];
  const slot = slotAt(seatAvailability(config, bookings, day, 2, undefined, now), day, "19:30")!;
  assert.equal(slot.remaining, 0, "never negative");
  assert.equal(slot.fits, false);
  assert.equal(seatOverflow(config, bookings, day), 8);
  const board = seatBoard(config, bookings, day);
  assert.deepEqual(board.find(row => row.time === "19:30"), { time: "19:30", reservable: 10, booked: 18, remaining: 0, overflow: 8 });
  assert.deepEqual(board.find(row => row.time === "17:00"), { time: "17:00", reservable: 10, booked: 0, remaining: 10, overflow: 0 });
  assert.equal(seatOverflow(akari(), bookings, day), 0);
});

test("foods to avoid are judged from the lists alone", () => {
  const seafood = akari().menus[1], winter = akari().menus[0];
  for (const word of ["えび", "エビ", "海老", "shrimp", "Shrimp", "prawns"]) assert.equal(matchAvoid(seafood, word), "contains", word);
  assert.equal(matchAvoid(winter, "えび"), "not_listed");
  assert.equal(matchAvoid(winter, "小麦"), "contains", "listed as an allergen though no ingredient names it");
  assert.equal(matchAvoid(winter, "ねぎ"), "contains", "a free word matches ingredients");
  assert.equal(matchAvoid(winter, "x"), "unknown");
  assert.equal(matchAvoid({ ingredients: undefined, allergens: [] }, "えび"), "unknown");
  const found = findMenuItems(akari(), { kind: "course", partySize: 12, budgetPerPerson: 5000, avoid: ["えび"] });
  assert.deepEqual(found.items.map(item => [item.id, item.matchesAvoid, item.priceText]), [["winter-robata", "not_listed", "5,000円/人"]]);
  assert.equal(found.items[0].allergenNote, "同じ厨房でえびを扱います。");
  const all = findMenuItems(akari(), { avoid: ["shrimp"] });
  assert.deepEqual(all.items.filter(item => item.matchesAvoid === "contains").map(item => item.id), ["seafood-robata", "ebi-kushi"]);
  assert.throws(() => findMenuItems(akari(), { kind: "soup" }));
});

test("seeded shops answer the demo's two questions", async () => {
  const store = new Store(":memory:");
  const seeded = await seedRestaurantDemo(store, now, undefined);
  assert.equal(seeded.banquetDate, "2030-01-11");
  assert.equal(nextFriday("2030-01-11"), "2030-01-18", "on a Friday, the banquet day is the following Friday");
  assert.deepEqual(seeded.shops, ["akari", "trattoria-sole", "kanton-ryu"]);
  assert.deepEqual((await seedRestaurantDemo(store, now)).shops, [], "seeding twice adds nothing");
  const shops = await store.list<import("../server/store.ts").Shop>("shop");
  const ask = async (slug: string, input: Record<string, unknown>) => {
    const shop = shops.find(candidate => candidate.slug === slug)!;
    return checkAvailability(shop.published!, await store.bookings(shop.id), "https://example.test/reserve", input, now);
  };
  // The banquet: twelve guests on the banquet day at 19:00.
  const banquet = { date: seeded.banquetDate, time: "19:00", partySize: 12 };
  assert.deepEqual((await ask("akari", banquet)).slots, [{ start: "19:00", remaining: 14, fits: true }]);
  assert.equal((await ask("akari", banquet)).reservationType, "large_party");
  assert.deepEqual((await ask("trattoria-sole", banquet)).slots, [{ start: "19:00", remaining: 30, fits: true }]);
  assert.equal((await ask("trattoria-sole", banquet)).durationMinutes, 150);
  const full = await ask("kanton-ryu", { ...banquet, courseId: "round-table" });
  assert.deepEqual(full.slots, [{ start: "19:00", remaining: 6, fits: false }]);
  assert.deepEqual(full.otherTimesThatFit, []);
  // Tonight: two guests, seats only.
  const tonight = { date: seeded.today, time: "19:00", partySize: 2 };
  assert.deepEqual((await ask("akari", tonight)).slots, [{ start: "19:00", remaining: 18, fits: true }]);
  assert.equal((await ask("akari", tonight)).durationMinutes, 90);
  assert.deepEqual((await ask("trattoria-sole", tonight)).slots, [{ start: "19:00", remaining: 26, fits: true }]);
  const courseOnly = await ask("kanton-ryu", tonight);
  assert.equal(courseOnly.seatOnlyAllowed, false);
  assert.deepEqual(courseOnly.slots, []);
  assert.match(courseOnly.reason!, /4〜16名/);
  // Nothing an agent reads names a guest.
  assert.doesNotMatch(JSON.stringify([await ask("akari", banquet), await ask("akari", tonight)]), /デモのご予約|seed-guest/);
});

async function serve(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:");
  const seeded = await seedRestaurantDemo(store, new Date());
  const server = createApp(store);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.APP_ORIGIN = origin;
  t.after(() => { server.close(); void store.close(); });
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  return { store, seeded, origin, post, get: (path: string, headers: Record<string, string> = {}) => fetch(origin + path, { headers, redirect: "manual" }) };
}

test("a reservation takes seats: seats only or with a course, never twice, never beyond the seats", async t => {
  const { store, seeded, post, get } = await serve(t);
  const date = seeded.banquetDate;
  const seats = await (await get(`/api/public/akari/seats?date=${date}&people=12&course=winter-robata`)).json();
  assert.equal(seats.durationMinutes, 120);
  assert.equal(seats.reservable, 20);
  assert.equal(seats.slots.find((slot: { start: string }) => slot.start === at(date, "19:00")).remaining, 14);
  assert.equal((await get(`/api/public/akari/seats?date=${date}&people=0`)).status, 400);
  const refused = await (await get(`/api/public/kanton-ryu/seats?date=${date}&people=4`)).json();
  assert.equal(refused.problem, "seat_only");
  assert.deepEqual(refused.slots, []);

  const requestId = "7b0e3d0e-6a0f-4c57-9d57-0d5d7f1f3a10";
  const banquet = { name: " 森田 ", date, time: "19:00", partySize: 12, courseId: "winter-robata", dietaryNote: "1名えびNG", phone: "090-1234-5678", expectedTotal: 60000, requestId };
  assert.equal((await post("/api/public/akari/bookings", { ...banquet, expectedTotal: 59999, requestId: undefined })).status, 409, "the total the guest saw must match");
  const made = await (await post("/api/public/akari/bookings", banquet)).json();
  assert.equal(made.ok, true);
  assert.deepEqual([made.booking.name, made.booking.partySize, made.booking.courseId, made.booking.menuId, made.booking.durationMinutes, made.booking.price, made.booking.staffId, made.booking.dietaryNote],
    ["森田", 12, "winter-robata", "winter-robata", 120, 60000, "owner", "1名えびNG"]);
  assert.deepEqual(made.booking.contact, { phone: "090-1234-5678" });
  assert.equal(made.booking.end, at(date, "21:00"));
  const again = await (await post("/api/public/akari/bookings", banquet)).json();
  assert.equal(again.booking.id, made.booking.id, "a repeated request returns the same reservation");
  assert.equal((await post("/api/public/akari/bookings", { ...banquet, partySize: 11, expectedTotal: 55000 })).status, 409, "the same request with other details is refused");
  // 20 seats, 6 seeded + 12 reserved: two are left at 19:00.
  const three = await post("/api/public/akari/bookings", { name: "三人", date, time: "19:00", partySize: 3, phone: "0311112222" });
  assert.equal(three.status, 409);
  assert.match((await three.json()).error, /満席/);
  const pair = await (await post("/api/public/akari/bookings", { name: "二人", date, time: "19:00", partySize: 2, phone: "0333334444" })).json();
  assert.deepEqual([pair.booking.menuId, pair.booking.courseId, pair.booking.price, pair.booking.durationMinutes], ["seat", undefined, 0, 90]);
  assert.equal(bookingMenuName(null, pair.booking), "席のみ");
  // Two guests arriving together for the last seats: one of them is refused.
  const race = await Promise.all([1, 2].map(n => post("/api/public/trattoria-sole/bookings", { name: `race${n}`, date, time: "20:00", partySize: 16, phone: "0312345678" })));
  assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
  // A course-only restaurant, an unknown course, a party outside the course's range, a time that is not offered.
  for (const body of [{ partySize: 4 }, { partySize: 4, courseId: "mapo-tofu" }, { partySize: 4, courseId: "nothing" }, { partySize: 4, courseId: "round-table", time: "19:10" }])
    assert.equal((await post("/api/public/kanton-ryu/bookings", { name: "x", date, time: "19:00", phone: "0312345678", ...body })).status, 409, JSON.stringify(body));
  assert.equal((await post("/api/public/akari/bookings", { name: "x", date, time: "19:00", partySize: 2, menuId: "seat" })).status, 400, "unknown fields are refused");
  const akariShop = (await store.list<import("../server/store.ts").Shop>("shop")).find(shop => shop.slug === "akari")!;
  assert.equal((await store.bookings(akariShop.id)).filter(booking => booking.start === at(date, "19:00")).reduce((total, booking) => total + booking.partySize!, 0), 20);
  for (const column of ["partySize", "courseId", "durationMinutes", "dietaryNote"]) assert.ok((exportColumns.bookings as readonly string[]).includes(column));
});

test("restaurant guests book without demo mode, membership or a login cookie", async t => {
  const { store, seeded, post, get } = await serve(t);
  const previousDemo = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "false";
  t.after(() => { process.env.DEMO_MODE = previousDemo; });
  const akari = (await store.list<import("../server/store.ts").Shop>("shop")).find(shop => shop.slug === "akari")!;
  // Shop notices use the platform sender without the owner's Google connection; this test only queues them.
  assert.equal(akari.google, undefined);
  const usersBefore = await store.list("user"), membersBefore = await store.list("customer");
  const config = await (await get("/api/public/akari")).json();
  assert.equal(config.registrationRequired, false);
  assert.equal(config.authUrl, undefined);
  assert.equal(config.demoCustomer, undefined);
  const input = { name: "会員ではないお客様", date: seeded.banquetDate, time: "18:00", partySize: 2, phone: "09012345678", requestId: "853f0440-32e5-4cc3-a294-3290bb8c1418" };
  const response = await post("/api/public/akari/bookings", input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const receipt = await response.json();
  assert.equal(receipt.booking.customer, "tel:+819012345678");
  const retry = await (await post("/api/public/akari/bookings", input)).json();
  assert.equal(retry.booking.id, receipt.booking.id);
  assert.equal((await post("/api/public/akari/bookings", { ...input, name: "別人" })).status, 409);
  assert.equal((await post("/api/public/akari/bookings", { ...input, requestId: undefined, phone: undefined })).status, 400);
  assert.equal((await post("/api/public/akari/bookings", { ...input, requestId: undefined, phone: undefined, email: "guest@example.com" })).status, 400, "a guest is reached by phone only: an email is not accepted");
  assert.equal((await post("/api/public/akari/bookings", { ...input, requestId: undefined, email: "guest@example.com" })).status, 400);
  assert.equal((await post("/api/public/akari/bookings", { ...input, requestId: undefined, phone: "(+) - - -" })).status, 400);
  const spaced = await (await post("/api/public/akari/bookings", { ...input, phone: "090-1234-5678" })).json();
  assert.equal(spaced.booking.id, receipt.booking.id, "the same request with the number written another way is not a second reservation");
  assert.equal((await get("/api/public/akari/bookings")).status, 401, "anonymous callers cannot list guest reservations");
  const mails = (await store.list<{ type: string; to: string; cc?: string[]; subject: string; body: string }>("job")).filter(job => job.type === "mail");
  assert.equal(mails.length, 1, "one notice per reservation, and the retries add none");
  assert.deepEqual([mails[0].to, ...(mails[0].cc || [])].sort(), [...new Set([akari.published!.notificationEmail, akari.owner])].sort(), "only the shop is mailed");
  assert.match(mails[0].subject, /ご予約が入りました/);
  assert.match(mails[0].body, /電話番号: 09012345678[\s\S]*折り返し/);
  assert.match(await (await get("/s/akari/reserve")).text(), /確認のお電話を差し上げます/);
  // A busy shop makes no call: the page and the shop's notice say when late seats are given up.
  akari.published = { ...akari.published!, seating: { ...akari.published!.seating!, confirmationCall: false } };
  await store.saveShop(akari);
  assert.equal((await post("/api/public/akari/bookings", { ...input, name: "二組目", phone: "0355556666", requestId: undefined })).status, 200);
  const busy = (await store.list<{ type: string; body: string }>("job")).filter(job => job.type === "mail").find(job => job.body.includes("二組目"))!;
  assert.match(busy.body, /確認の電話は不要です。ご予約時刻から5分を過ぎても/);
  assert.doesNotMatch(busy.body, /折り返し/);
  const busyPage = await (await get("/s/akari/reserve")).text();
  assert.match(busyPage, /5分を過ぎてもご来店がない場合は、他のお客様をご案内します/);
  assert.doesNotMatch(busyPage, /reserve-email|確認のお電話を差し上げます/);
  // Nobody signs in, so one phone number holds a few upcoming reservations at most, and one address makes a few an hour.
  const slot = (n: number) => ({ name: "同じ番号", date: seeded.banquetDate, time: ["17:00", "17:30", "18:30", "19:30"][n], partySize: 1, phone: "0377778888" });
  assert.deepEqual(await Promise.all([0, 1, 2].map(async n => (await post("/api/public/akari/bookings", slot(n))).status)), [200, 200, 200]);
  const fourth = await post("/api/public/akari/bookings", slot(3));
  assert.equal(fourth.status, 409);
  assert.match((await fourth.json()).error, /上限/);
  const statuses: number[] = [];
  for (let n = 0; n < 7; n++) statuses.push((await post("/api/public/akari/bookings", { name: `連続${n}`, date: seeded.banquetDate, time: "17:00", partySize: 1, phone: `03900000${10 + n}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429], "ten reservations an hour from one address, counting the five above");
  assert.equal((await post("/api/public/akari/bookings", input)).status, 200, "a retry of a reservation already made is still answered");
  assert.equal((await post("/api/public/akari/activity", { event: "reserve_view" })).status, 200, "a guest's screen view is ignored, not refused");
  assert.deepEqual(await store.list("user"), usersBefore);
  assert.deepEqual(await store.list("customer"), membersBefore);
  for (const path of ["/s/akari", "/s/akari/reserve"]) {
    const html = await (await get(path)).text();
    assert.doesNotMatch(html, /public-auth|pane=mine|pane=contact|#email-login/);
  }
});

test("information-only restaurants publish without menus or seats and expose no booking entry points", async t => {
  const { store, get, post, seeded } = await serve(t);
  let shop = (await store.list<import("../server/store.ts").Shop>("shop")).find(shop => shop.slug === "akari")!;
  const config = shopSchema.parse({ ...shop.published!, reservationsEnabled: false, seating: undefined, menus: [] });
  assert.equal(canPublishShop(config), true);
  assert.equal(takesBookings(config), false);
  shop.published = config; shop.publication = "provisional"; delete shop.storefrontRelease;
  await store.saveShop(shop);
  const login = await post("/api/demo-login", { role: "owner", email: shop.owner });
  const Cookie = login.headers.get("set-cookie")!.split(";")[0];
  const preview = await (await get(`/api/shops/${shop.id}/publication-preview`, { Cookie })).json();
  assert.equal((await post(`/api/shops/${shop.id}/publication`, { publication: "public", revision: preview.revision, hash: preview.hash }, { Cookie })).status, 200);
  const html = await (await get("/s/akari")).text();
  assert.doesNotMatch(html, /id="assistant-toggle"|id="reserve-form"|href="[^"]*(?:reserve|pane=mine|pane=contact)|public-auth/);
  assert.equal((await get("/s/akari/reserve")).status, 404);
  assert.equal((await get("/s/akari/agent/agent-manifest.json")).status, 404);
  assert.equal((await post("/api/public/akari/bookings", { name: "x", date: seeded.banquetDate, time: "18:00", partySize: 2, phone: "0312345678" })).status, 409);
  assert.deepEqual((await (await get(`/api/public/akari/seats?date=${seeded.banquetDate}&people=2`)).json()).slots, []);
  const enabled = updateLiveValue({ ...akari(), reservationsEnabled: false }, "basic", { ...config, reservationsEnabled: true });
  assert.equal(enabled.reservationsEnabled, true);
});

test("the read-only MCP server answers any origin, without cookies, and names no guest", async t => {
  const { seeded, origin, post, get } = await serve(t);
  const rpc = async (slug: string, method: string, params?: unknown, id: number | null = 1) => post(`/s/${slug}/agent/mcp`, { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }, { Origin: "http://localhost:8090", Cookie: "gemihub_session=nothing" });
  const preflight = await fetch(`${origin}/s/akari/agent/mcp`, { method: "OPTIONS", headers: { Origin: "http://localhost:8090", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, mcp-protocol-version" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers")!, /MCP-Protocol-Version/);
  const initialized = await rpc("akari", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(initialized.headers.get("access-control-allow-origin"), "*");
  assert.equal(initialized.headers.get("set-cookie"), null);
  assert.equal(initialized.headers.get("x-frame-options"), null);
  assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
  assert.equal((await rpc("akari", "notifications/initialized", {}, null)).status, 202);
  const tools = (await (await rpc("akari", "tools/list")).json()).result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["check_availability", "find_menu_items", "get_shop_info"]);
  assert.ok(tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint));
  const call = async (slug: string, name: string, args: unknown) => (await (await rpc(slug, "tools/call", { name, arguments: args })).json()).result;
  const seats = await call("akari", "check_availability", { date: seeded.banquetDate, time: "19:00", partySize: 12 });
  assert.equal(seats.isError, false);
  assert.deepEqual(seats.structuredContent.slots, [{ start: "19:00", remaining: 14, fits: true }]);
  assert.deepEqual(JSON.parse(seats.content[0].text), seats.structuredContent);
  assert.equal(seats.structuredContent.reservePageUrl, `${origin}/s/akari/reserve`);
  const menu = await call("akari", "find_menu_items", { kind: "course", avoid: ["えび"] });
  assert.deepEqual(menu.structuredContent.items.map((item: { id: string; matchesAvoid: string }) => [item.id, item.matchesAvoid]), [["winter-robata", "not_listed"], ["seafood-robata", "contains"]]);
  assert.doesNotMatch(JSON.stringify([seats, menu]), /デモのご予約|seed-guest|owner@example/);
  assert.equal((await call("akari", "check_availability", { date: "tomorrow", partySize: 2 })).isError, true);
  assert.equal((await (await rpc("akari", "tools/call", { name: "place_reservation", arguments: {} })).json()).error.code, -32602, "no tool writes");
  assert.equal((await (await rpc("akari", "resources/list")).json()).error.code, -32601);
  assert.equal((await fetch(`${origin}/s/akari/agent/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await get("/s/akari/agent/mcp")).status, 405);
  assert.equal((await rpc("nobody", "tools/list")).status, 404);
  // Sixty calls a minute for one address; the rest wait.
  const statuses = await Promise.all(Array.from({ length: 70 }, () => rpc("akari", "ping").then(response => response.status)));
  assert.ok(statuses.includes(429) && statuses.includes(200));
});

test("the public bundle is built by the official script and served with the headers other sites need", async t => {
  const { origin, get } = await serve(t);
  const base = "/s/akari/agent";
  const manifestResponse = await get(`${base}/agent-manifest.json`, { Origin: "http://localhost:8090" });
  assert.equal(manifestResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(manifestResponse.headers.get("vary"), null, "the same for every caller");
  const manifest = await manifestResponse.json();
  assert.deepEqual([manifest.networks[0].name, manifest.networks[0].front_man, manifest.networks[0].hocon], ["reservation_concierge", "reservation_front", "./reservation_concierge.network.json"]);
  assert.deepEqual(manifest.allowed_peers, [origin]);
  assert.equal(manifest.peer_policy.mode, "closed");
  assert.equal(manifest.llm_router.mock, false);
  assert.deepEqual(manifest.actions.agentTools, ["get_reservation_page_state", "get_reservation_request", "fill_reservation_form", "place_reservation"]);
  const network = await (await get(`${base}/reservation_concierge.network.json`)).json();
  assert.deepEqual(network.metadata.sample_queries, manifest.networks[0].sample_queries);
  assert.deepEqual(network.tools.map((agent: { name: string }) => agent.name), ["reservation_front", "menu_allergen_checker"]);
  assert.deepEqual(network.tools[0].tools, ["menu_allergen_checker", { url: `${origin}/s/akari/agent/mcp`, tools: ["check_availability", "find_menu_items", "get_shop_info"] }]);
  assert.match(network.tools[0].instructions, /\{peer_rules\}/);
  assert.match(network.commondefs.replacement_strings.site_name, /炉端 灯/);
  assert.doesNotMatch(JSON.stringify(network), /demo_mode|__[A-Z_]+__|TODO/);
  for (const file of ["links.json", "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json"]) {
    const response = await get(`${base}/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", file);
  }
  // Other sites load the bridge in a hidden frame.
  const bridge = await get(`${base}/bridge/action-bridge.html`);
  assert.equal(bridge.status, 200);
  assert.equal(bridge.headers.get("x-frame-options"), null);
  assert.doesNotMatch(bridge.headers.get("content-security-policy")!, /frame-ancestors/);
  assert.equal((await (await get(`${base}/bridge/agent-manifest.json`)).json()).actions?.module, undefined, "the bridge shares no actions");
  const worker = await get(`${base}/runtime/sandbox-worker.js`);
  assert.equal(worker.headers.get("content-security-policy"), "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'");
  assert.equal((await get(`${base}/runtime/index.js`)).status, 200);
  for (const file of ["site.js", "ai-connection.js", "reservation-actions.js", "reserve-page.js", "review-dialog.js", "hybrid.bundle.js", "hybrid-config.json", "hybrid.css", "voice-bridge.js", "voice-turn.js", "assistant.css"]) assert.equal((await get(`${base}/${file}`)).status, 200, file);
  const relayWorker = await get(`${base}/llm-relay-sw.js`);
  assert.equal(relayWorker.status, 404);
  const facts = await (await get(`${base}/facts.json`)).json();
  assert.equal(facts.name, akari().name);
  assert.equal(facts.notificationEmail, undefined);
  assert.equal(facts.staff, undefined);
  assert.equal(facts.reservations, undefined);
  assert.equal(relayWorker.headers.get("access-control-allow-origin"), null);
  assert.equal((await get(`${base}/llm-bridge/v1/chat/completions`)).status, 404, "without the worker the server never forwards a model request");
  for (const path of [`${base}/runtime/%2e%2e/%2e%2e/%2e%2e/package.json`, `${base}/reservation_concierge.hocon`, `${base}/nothing.json`, "/s/nobody/agent/agent-manifest.json"]) assert.equal((await get(path)).status, 404, path);
  // The page lets the browser reach the visitor's own LLM provider; nothing else on the site does.
  const reservation = await get("/s/akari/reserve?lang=en");
  assert.equal(reservation.status, 200);
  const page = reservation;
  assert.match(page.headers.get("content-security-policy")!, /connect-src 'self' https:/);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /id="agent-app"/);
  const business = await get("/api/public/akari", { Origin: "http://localhost:8090" });
  assert.equal(business.headers.get("access-control-allow-origin"), null, "business endpoints stay same-origin");
  assert.match(business.headers.get("content-security-policy")!, /connect-src 'self';/);
  const escaped = await get("/s/trattoria-sole/reserve");
  assert.equal(escaped.status, 200);
  const reservationHtml = await escaped.text();
  assert.match(reservationHtml, /class="restaurant-reservation-page"/);
  assert.doesNotMatch(reservationHtml, /id="restaurant-reservation"|class="panel about"/);
});

test("reservation pages share the published theme and upgrade releases missing that page", async t => {
  const { get, store } = await serve(t);
  const home = await (await get("/s/akari")).text();
  let shop = (await store.list<import("../server/store.ts").Shop>("shop")).find(shop => shop.slug === "akari")!;
  shop.storefrontRelease!.paths = shop.storefrontRelease!.paths.filter(path => !path.endsWith("/reserve.html"));
  shop.storefrontRelease!.renderer = 9;
  await store.saveShop(shop);
  const response = await get("/s/akari/reserve");
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /class="restaurant-reservation-page"/);
  assert.match(page, /id="reserve-form"/);
  assert.equal((page.match(/id="assistant-toggle"/g) || []).length, 1);
  assert.doesNotMatch(page, /class="panel about"|agent\/reserve\.css/);
  assert.equal(page.match(/href="([^"]*\/_assets\/[^"]*\.css)"/)?.[1], home.match(/href="([^"]*\/_assets\/[^"]*\.css)"/)?.[1]);
  assert.equal((await store.shop(shop.id))!.storefrontRelease!.renderer, 10);
});

test("a salon keeps its staff-based booking and has no agent bundle", async t => {
  const { store, get, post } = await serve(t);
  const owner = (await post("/api/demo-login", { role: "owner", email: "salon@example.com" })).headers.get("set-cookie")!.split(";")[0];
  const shop = (await store.list<import("../server/store.ts").Shop>("shop")).find(candidate => candidate.owner === "salon@example.com")!;
  shop.published = shopSchema.parse(structuredClone(sample)) as ShopConfig;
  shop.publication = "public";
  await store.saveShop(shop);
  assert.ok(owner);
  assert.equal((await get(`/s/${shop.slug}/agent/agent-manifest.json`)).status, 404);
  assert.equal((await get(`/s/${shop.slug}/agent/mcp`)).status, 404);
  const seats = await (await get(`/api/public/${shop.slug}/seats?date=2030-01-10&people=2`)).json();
  assert.equal(seats.problem, "not_restaurant");
});

test("a shop can become a restaurant, and a seats-only restaurant can be public without a course", () => {
  const salon = shopSchema.parse(structuredClone(sample));
  // The basic settings carry only the industry: seats, kinds and hidden menus follow from it.
  const switched = updateLiveValue(salon, "basic", { name: salon.name, industry: "restaurant", description: salon.description, address: salon.address, notificationEmail: salon.notificationEmail });
  assert.equal(switched.industry, "restaurant");
  assert.deepEqual(switched.seating, { ...defaultSeating(salon.hours), overrides: [] });
  assert.deepEqual(switched.seating!.startTimes, halfHours("10:00", "16:00"), "every half hour that leaves two hours before closing");
  assert.deepEqual(switched.staff, []);
  assert.ok(switched.menus.every(menu => !menu.active && menu.kind === "course"), "menus wait, hidden, for their ingredients");
  assert.equal(takesBookings(switched), true, "seats alone can be reserved, so the shop may stay public");
  assert.equal(takesBookings({ ...switched, seating: { ...switched.seating!, seatOnly: false } }), false);
  assert.equal(takesBookings(salon), true);
  assert.equal(takesBookings({ ...salon, menus: [] }), false);
  // A first proposal that only names the industry, as the interview returns it.
  const proposed = shopSchema.parse(asRestaurant({ ...structuredClone(sample), industry: "restaurant" as const, menus: [], staff: [] }));
  assert.equal(proposed.seating!.reservableSeats, 20);
  const settled = restaurantDemoShops("2030-01-11")[0].config;
  assert.equal(asRestaurant(settled), settled, "a restaurant with seat settings is left alone");
  // A shown item with no kind would be invisible to reservations and to agents, so it cannot be saved.
  const kindless = structuredClone(settled);
  delete kindless.menus[0].kind;
  assert.equal(shopSchema.safeParse(kindless).success, false);
});

test("a compound or variant word still names its allergen, and an English word only as a whole word", () => {
  const skewer = { ingredients: ["えび", "塩"], allergens: ["shrimp" as const] };
  for (const food of ["甘えび", "車海老", "king prawn", "ボタンエビ", "Shrimps"]) assert.equal(matchAvoid(skewer, food), "contains", food);
  assert.equal(matchAvoid({ ingredients: ["鶏卵", "砂糖"], allergens: [] }, "生卵"), "contains", "an ingredient written another way");
  assert.equal(matchAvoid({ ingredients: ["eggplant", "oil"], allergens: [] }, "egg"), "not_listed");
  assert.equal(matchAvoid({ ingredients: ["flour"], allergens: ["egg" as const] }, "eggplant"), "not_listed", "eggplant does not name egg");
  assert.equal(matchAvoid({ ingredients: ["soy milk"], allergens: [] }, "milk"), "contains");
});

test("the rate limit follows the visitor behind a trusted proxy, and each shop has its own", async t => {
  const request = (forwarded: string | undefined, remoteAddress: string) => ({ headers: forwarded ? { "x-forwarded-for": forwarded } : {}, socket: { remoteAddress } }) as unknown as import("node:http").IncomingMessage;
  assert.equal(clientAddress(request("203.0.113.9, 10.0.0.1", "10.0.0.2"), 0), "10.0.0.2", "no proxy is trusted unless configured");
  assert.equal(clientAddress(request("198.51.100.7, 203.0.113.9", "10.0.0.2"), 1), "203.0.113.9", "the entry the trusted proxy added, not one the client wrote");
  assert.equal(clientAddress(request("198.51.100.7, 203.0.113.9, 10.0.0.1", "10.0.0.2"), 2), "203.0.113.9");
  assert.equal(clientAddress(request(undefined, "10.0.0.2"), 1), "10.0.0.2");
  const { post } = await serve(t);
  const ping = (slug: string) => post(`/s/${slug}/agent/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" }).then(response => response.status);
  assert.ok((await Promise.all(Array.from({ length: 65 }, () => ping("akari")))).includes(429));
  assert.equal(await ping("trattoria-sole"), 200, "one busy restaurant does not close the others");
});

test("a restaurant on its own host serves the same page and bundle at the root", async t => {
  process.env.SITE_DOMAIN = "shops.test";
  t.after(() => { delete process.env.SITE_DOMAIN; });
  const { origin } = await serve(t);
  const hosted = (path: string, host = "akari.shops.test") => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const call = httpRequest(origin + path, { headers: { Host: host } }, response => {
      let body = "";
      response.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    call.on("error", reject).end();
  });
  const reservation = await hosted("/reserve?lang=en");
  assert.equal(reservation.status, 200);
  const page = reservation;
  assert.equal(page.status, 200);
  assert.match(page.body, /data-slug="akari"/);
  assert.match(page.body, /src="\/agent\/reserve-page\.js"/);
  assert.match(page.body, /class="restaurant-reservation-page"/);
  assert.doesNotMatch(page.body, /agent\/reserve\.css|reserve-shell/);
  const manifest = JSON.parse((await hosted("/agent/agent-manifest.json")).body);
  assert.deepEqual(manifest.allowed_peers, ["https://akari.shops.test"]);
  const network = JSON.parse((await hosted("/agent/reservation_concierge.network.json")).body);
  assert.equal(network.tools[0].tools[1].url, "https://akari.shops.test/agent/mcp");
  assert.equal((await hosted("/agent/runtime/index.js")).status, 200);
  assert.equal((await hosted("/agent/llm-relay-sw.js")).status, 404);
  assert.equal((await hosted("/api/public/akari/seats?date=2030-01-10&people=2")).status, 200, "the page's own calls work on that host");
});

test("shop information and reservation conditions come from the shop's own settings, with the time they were read", async t => {
  const config = restaurantDemoShops("2030-01-11")[2].config;
  const info = shopInfo(config, "https://example.test/reserve", {}, now);
  assert.deepEqual([info.shop, info.address, info.hours.regular, info.checkedAt], ["広東 龍", "神奈川県横浜市（デモ用の架空のお店です）", "17:30 – 23:00", now.toISOString()]);
  assert.deepEqual(info.reservation, { partySize: { min: 4, max: 16 }, seatOnlyAllowed: false, startTimes: ["17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30"], standardMinutes: 120, largePartyMinutes: 120, largePartyFrom: 8,
    advanceDays: 90, sameDay: true, leadMinutes: 0, cancellation: "キャンセルは開始の24時間前まで受け付けます。", payment: "お支払いは当日お店で。オンライン決済はありません。" });
  assert.doesNotMatch(JSON.stringify(info), /owner@example|notificationEmail/, "the owner's address is not public");
  assert.throws(() => shopInfo(config, "https://example.test/reserve", { anything: 1 }));
  assert.equal(checkAvailability(config, [], "https://example.test/reserve", { date: "2030-01-11", partySize: 4, courseId: "veggie-table" }, now).checkedAt, now.toISOString());
  assert.equal(findMenuItems(config, {}, now).checkedAt, now.toISOString());
  const { post } = await serve(t);
  const called = await (await post("/s/kanton-ryu/agent/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_shop_info", arguments: {} } })).json();
  assert.equal(called.result.structuredContent.shop, "広東 龍");
  assert.match(called.result.structuredContent.reservePageUrl, /\/s\/kanton-ryu\/reserve$/);
});

test("only the registered finder site may frame the reservation page, without finder links on shop pages", async t => {
  const previous = process.env.AGENT_PARENT_URL;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_PARENT_URL; else process.env.AGENT_PARENT_URL = previous; });
  const { get, store } = await serve(t);
  const shop = (await store.list<import("../server/store.ts").Shop>("shop")).find(shop => shop.slug === "akari")!;
  shop.published!.pages.push({ id: "access", slug: "access", title: "アクセス", navigationLabel: "アクセス", body: "<p>店舗内ページです。</p>", imageUrl: "", layout: "standard" });
  await store.saveShop(shop);
  delete process.env.AGENT_PARENT_URL;
  const staticPage = await get("/s/akari");
  const previousEtag = staticPage.headers.get("etag")!;
  assert.doesNotMatch(await staticPage.text(), /class="agent-consult"/);
  const alone = await get("/s/akari/reserve");
  assert.equal(alone.headers.get("x-frame-options"), "DENY");
  assert.match(alone.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.doesNotMatch(await alone.text(), /reserve-consult|data-parent-origin/);
  assert.equal((await get("/s/akari/pages/access")).headers.get("x-frame-options"), "DENY");
  process.env.AGENT_PARENT_URL = "http://localhost:8090/";
  const framed = await get("/s/akari/reserve");
  assert.equal(framed.headers.get("x-frame-options"), null);
  assert.match(framed.headers.get("content-security-policy")!, /frame-ancestors http:\/\/localhost:8090;/);
  const html = await framed.text();
  assert.match(html, /data-parent-origin="http:\/\/localhost:8090"/);
  assert.doesNotMatch(html, /reserve-consult|href="http:\/\/localhost:8090/);
  const top = await get("/s/akari", { "If-None-Match": previousEtag });
  assert.equal(top.status, 200, "the restaurant assistant reflects the configured parent origin");
  const shopHome = await top.text();
  assert.match(shopHome, /id="assistant-toggle"/);
  assert.match(shopHome, /data-parent-origin="http:\/\/localhost:8090"/);
  assert.match(shopHome, /id="restaurant-reservation"/);
  assert.match(shopHome, /id="restaurant-reservation"[^>]* hidden/);
  const legacyBookingLink = await get("/s/akari?pane=reserve&lang=en");
  assert.equal(legacyBookingLink.status, 302);
  assert.match(legacyBookingLink.headers.get("location")!, /^\/s\/akari\/reserve\?lang=en$/);
  for (const path of ["/s/akari/pages/access"]) {
    const destination = await get(path);
    assert.equal(destination.status, 200, path);
    assert.equal(destination.headers.get("x-frame-options"), null, path);
    assert.match(destination.headers.get("content-security-policy")!, /frame-ancestors http:\/\/localhost:8090;/, path);
  }
  const article = await (await get("/s/akari/pages/access")).text();
  assert.match(article, /id="assistant-toggle"/);
  assert.match(article, /data-parent-origin="http:\/\/localhost:8090"/);
  assert.equal((await (await get("/api/public/akari")).json()).agentChatUrl, undefined);
  for (const lang of ["ja", "en"]) {
    for (const path of ["/s/akari", "/s/akari/reserve"]) {
      const response = await get(`${path}?lang=${lang}`);
      const page = await (response.status === 302 ? await get(response.headers.get("location")!) : response).text();
      assert.doesNotMatch(page, /agent-consult|reserve-consult|AIに相談（お店さがしサイトへ移動）|Ask the AI \(opens the restaurant finder\)/);
    }
  }
  // API and management screens remain unframeable.
  assert.equal((await get("/api/public/akari")).headers.get("x-frame-options"), "DENY");
  assert.equal((await get("/")).headers.get("x-frame-options"), "DENY");
  assert.equal((await get("/s/akari")).headers.get("x-frame-options"), null);
  for (const value of ["javascript:alert(1)", "http://finder.example/", "https://finder.example/?next=1", "https://user:pw@finder.example/", "not a url", ""]) {
    process.env.AGENT_PARENT_URL = value;
    assert.equal(parentSite(), undefined, value);
  }
  process.env.AGENT_PARENT_URL = "https://finder.example/app/";
  assert.deepEqual(parentSite(), { origin: "https://finder.example", url: "https://finder.example/app/" });
});
