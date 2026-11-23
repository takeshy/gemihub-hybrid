import { randomUUID } from "node:crypto";
import { parseLocale } from "../shared/i18n.ts";
import { dateIn, zonedDate } from "../shared/region.ts";
import { halfHours } from "../shared/seating.ts";
import { ownerStaffId, seatOnlyMenuId, shopSchema, type Booking, type ShopConfig } from "../server/domain.ts";
import { durationFor } from "../server/seats.ts";
import type { Shop, Store } from "../server/store.ts";

// Three demo restaurants for the reservation agents (DEMO_MODE with SEED=restaurant-demo).
// Dates are relative to the day the server starts: "tonight" and "the banquet day", which is
// the next Friday unless SEED_BANQUET_DATE names another date.

type Menu = ShopConfig["menus"][number];
const times = halfHours;
const course = (id: string, name: string, price: number, people: [number, number], ingredients: string[], allergens: Menu["allergens"], allergenNote?: string): Menu =>
  ({ id, name, kind: "course", duration: 120, price, active: true, minPeople: people[0], maxPeople: people[1], ingredients, allergens, ...(allergenNote ? { allergenNote } : {}) });
const dish = (id: string, name: string, price: number, ingredients: string[], allergens: Menu["allergens"] = [], kind: "dish" | "drink" = "dish"): Menu =>
  ({ id, name, kind, duration: 30, price, active: true, ingredients, allergens });

const englishShopCopy: Record<string, Pick<ShopConfig, "name" | "description" | "address"> & {
  menus: Record<string, Pick<Menu, "name" | "ingredients" | "allergenNote">>;
}> = {
  akari: {
    name: "Robata Akari", description: "Charcoal-grilled fish and vegetables at the counter or in a raised seating area. Tables for two and space for larger groups.",
    address: "Shinjuku, Tokyo (fictional restaurant)",
    menus: {
      "winter-robata": { name: "Winter robata course", ingredients: ["Chicken thigh", "Japanese leek", "Atka mackerel", "Daikon", "Rice", "Soy sauce"], allergenNote: "The same kitchen handles shrimp." },
      "seafood-robata": { name: "Seafood robata course", ingredients: ["Shrimp", "Scallops", "Squid", "Clams", "Rice", "Soy sauce"] },
      "ebi-kushi": { name: "Grilled shrimp skewers", ingredients: ["Shrimp", "Salt"] },
      "yaki-onigiri": { name: "Grilled rice ball", ingredients: ["Rice", "Soy sauce"] },
      "hot-sake": { name: "Warm sake (180 ml)", ingredients: ["Sake"] },
    },
  },
  "trattoria-sole": {
    name: "Trattoria Sole", description: "Wood-fired pizza and handmade pasta. Private parties are welcome.",
    address: "Shibuya, Tokyo (fictional restaurant)",
    menus: {
      "party-plan": { name: "Party menu", ingredients: ["Pasta", "Tomato", "Mozzarella", "Prosciutto", "Basil"] },
      "gluten-light": { name: "Gluten-light menu", ingredients: ["Risotto", "Beef", "Seasonal vegetables", "Parmigiano"], allergenNote: "Prepared in a kitchen that handles wheat." },
      margherita: { name: "Margherita pizza", ingredients: ["Wheat flour", "Tomato", "Mozzarella", "Basil"] },
      "seafood-salad": { name: "Seafood salad", ingredients: ["Shrimp", "Squid", "Lettuce", "Olive oil"] },
      "house-wine": { name: "House wine (glass)", ingredients: ["Grapes"] },
    },
  },
  "kanton-ryu": {
    name: "Canton Ryu", description: "Cantonese cooking served around round tables. Course reservations start at four guests.",
    address: "Yokohama, Kanagawa (fictional restaurant)",
    menus: {
      "round-table": { name: "Round-table banquet", ingredients: ["Chili shrimp", "Soup dumplings", "Peking duck", "Stir-fried greens", "Fried rice"] },
      "veggie-table": { name: "Vegetable banquet", ingredients: ["Tofu", "Greens", "Mushrooms", "Glass noodles"], allergenNote: "The same kitchen handles shrimp and crab." },
      "mapo-tofu": { name: "Mapo tofu", ingredients: ["Tofu", "Ground pork", "Chili bean paste"] },
    },
  },
};

export function restaurantDemoShops(banquetDate: string, locale = parseLocale(process.env.GEMIHUB_DEFAULT_LOCALE) || "ja"): { slug: string; owner: string; config: ShopConfig }[] {
  const base = {
    address: "",
    notificationEmail: "owner@example.com",
    staff: [],
    ownerBooking: true as const,
    rules: { interval: 30, advanceDays: 90, leadMinutes: 0, sameDay: true, cancelHours: 24 },
  };
  const shops = [
    {
      slug: "akari", owner: "akari-owner@example.com",
      config: {
        ...base, name: "炉端 灯", industry: "restaurant" as const,
        description: "炭火で焼く魚と野菜の炉端焼き。カウンターと小上がりで、2名から宴会まで。", address: "東京都新宿区（デモ用の架空のお店です）",
        appearance: { accent: "rose" as const, layout: "standard" as const, imageUrl: "" as const },
        hours: { start: "17:00", end: "23:30", closedWeekdays: [], holidays: [] },
        menus: [
          course("winter-robata", "冬の炉端コース", 5000, [2, 30], ["鶏もも", "長ねぎ", "ほっけ", "大根", "米", "醤油"], ["wheat"], "同じ厨房でえびを扱います。"),
          course("seafood-robata", "海鮮炉端コース", 6500, [2, 30], ["えび", "ほたて", "いか", "あさり", "米", "醤油"], ["shrimp", "wheat"]),
          dish("ebi-kushi", "えびの串焼き", 780, ["えび", "塩"], ["shrimp"]),
          dish("yaki-onigiri", "焼きおにぎり", 420, ["米", "醤油"], ["wheat"]),
          dish("hot-sake", "燗酒（一合）", 680, ["日本酒"], [], "drink"),
        ],
        seating: { reservableSeats: 24, standardMinutes: 90, largePartyMinutes: 120, largePartyFrom: 7, startTimes: times("17:00", "21:00"), minPartySize: 1, maxPartySize: 24, seatOnly: true,
          overrides: [{ date: banquetDate, reservableSeats: 20, note: "カウンター4席は当日のお客様用" }] },
      },
    },
    {
      slug: "trattoria-sole", owner: "sole-owner@example.com",
      config: {
        ...base, name: "トラットリア ソーレ", industry: "restaurant" as const,
        description: "薪窯のピッツァと手打ちパスタのトラットリア。貸切パーティーも承ります。", address: "東京都渋谷区（デモ用の架空のお店です）",
        appearance: { accent: "sage" as const, layout: "standard" as const, imageUrl: "" as const },
        hours: { start: "18:00", end: "23:30", closedWeekdays: [], holidays: [] },
        menus: [
          course("party-plan", "パーティープラン", 4500, [2, 30], ["パスタ", "トマト", "モッツァレラ", "生ハム", "バジル"], ["wheat", "egg", "milk"]),
          course("gluten-light", "グルテン控えめプラン", 5500, [2, 30], ["リゾット", "牛肉", "季節の野菜", "パルミジャーノ"], ["milk"], "小麦を扱う厨房で調理します。"),
          dish("margherita", "マルゲリータ", 1600, ["小麦粉", "トマト", "モッツァレラ", "バジル"], ["wheat", "milk"]),
          dish("seafood-salad", "海鮮サラダ", 1400, ["えび", "いか", "レタス", "オリーブオイル"], ["shrimp"]),
          dish("house-wine", "ハウスワイン（グラス）", 700, ["ぶどう"], [], "drink"),
        ],
        seating: { reservableSeats: 30, standardMinutes: 90, largePartyMinutes: 150, largePartyFrom: 6, startTimes: times("18:00", "20:30"), minPartySize: 2, maxPartySize: 30, seatOnly: true, overrides: [] },
      },
    },
    {
      slug: "kanton-ryu", owner: "ryu-owner@example.com",
      config: {
        ...base, name: "広東 龍", industry: "restaurant" as const,
        description: "円卓を囲む広東料理。ご予約はコースのみ、4名様から承ります。", address: "神奈川県横浜市（デモ用の架空のお店です）",
        appearance: { accent: "navy" as const, layout: "standard" as const, imageUrl: "" as const },
        hours: { start: "17:30", end: "23:00", closedWeekdays: [], holidays: [] },
        menus: [
          course("round-table", "円卓宴会", 6000, [4, 16], ["えびチリ", "小籠包", "北京ダック", "青菜炒め", "炒飯"], ["shrimp", "wheat", "egg"]),
          course("veggie-table", "ベジ円卓", 5000, [4, 16], ["豆腐", "青菜", "きのこ", "春雨"], [], "同じ厨房でえび・かにを扱います。"),
          dish("mapo-tofu", "麻婆豆腐", 1200, ["豆腐", "豚ひき肉", "豆板醤"]),
        ],
        seating: { reservableSeats: 16, standardMinutes: 120, largePartyMinutes: 120, largePartyFrom: 8, startTimes: times("17:30", "20:30"), minPartySize: 4, maxPartySize: 16, seatOnly: false, overrides: [] },
      },
    },
  ];
  return shops.map(shop => {
    const copy = locale === "en" ? englishShopCopy[shop.slug] : undefined;
    if (!copy) return { ...shop, config: shopSchema.parse(shop.config) };
    const { menus, ...text } = copy;
    const config = {
      ...shop.config,
      ...text,
      menus: shop.config.menus.map(menu => ({ ...menu, ...menus[menu.id] })),
      seating: { ...shop.config.seating, overrides: shop.config.seating.overrides.map(override => ({
        ...override, note: "Four counter seats are reserved for walk-in guests.",
      })) },
    };
    return { ...shop, config: shopSchema.parse(config) };
  });
}

/** The next Friday after `today` (never today itself), as YYYY-MM-DD. */
export function nextFriday(today: string) {
  const day = new Date(`${today}T00:00:00Z`);
  const ahead = (5 - day.getUTCDay() + 7) % 7 || 7;
  return new Date(day.getTime() + ahead * 86400000).toISOString().slice(0, 10);
}

export async function seedRestaurantDemo(store: Store, now = new Date(), banquet = process.env.SEED_BANQUET_DATE) {
  const today = dateIn(now, "Asia/Tokyo");
  const banquetDate = banquet && /^\d{4}-\d{2}-\d{2}$/.test(banquet) ? banquet : nextFriday(today);
  const existing = await store.list<Shop>("shop");
  const seeded: Shop[] = [];
  for (const { slug, owner, config } of restaurantDemoShops(banquetDate)) {
    if (existing.some(shop => shop.slug === slug)) continue;
    const shop: Shop = { id: randomUUID(), owner, slug, published: config, publication: "public", draft: null, revision: 1, history: [{ at: now.toISOString(), summary: "デモ用のお店を用意" }] };
    await store.saveShop(shop);
    await store.put("user", owner, { email: owner, name: `${config.name} 店主`, role: "owner", shopId: shop.id });
    seeded.push(shop);
  }
  const reserve = async (slug: string, date: string, time: string, partySize: number, courseId?: string) => {
    const shop = seeded.find(candidate => candidate.slug === slug);
    if (!shop) return;
    const config = shop.published!;
    const start = zonedDate(date, time, "Asia/Tokyo");
    const durationMinutes = durationFor(config, partySize, courseId);
    const item = courseId ? config.menus.find(menu => menu.id === courseId) : undefined;
    const booking: Booking = {
      id: randomUUID(), shopId: shop.id, customer: "seed-guest@example.com", name: "デモのご予約", message: "",
      menuId: courseId || seatOnlyMenuId, price: item ? item.price * partySize : 0, staffId: ownerStaffId,
      start: start.toISOString(), end: new Date(start.getTime() + durationMinutes * 60000).toISOString(),
      partySize, ...(courseId ? { courseId } : {}), durationMinutes, status: "active", createdAt: now.toISOString(),
    };
    await store.saveBooking(booking);
  };
  // The banquet day: Akari still fits twelve; Kanton Ryu, with ten of sixteen seats taken, does not.
  await reserve("akari", banquetDate, "19:00", 6, "winter-robata");
  await reserve("kanton-ryu", banquetDate, "19:00", 10, "round-table");
  // Tonight at 19:00: both seat-only shops still have room for two.
  for (let table = 0; table < 3; table++) await reserve("akari", today, "19:00", 2);
  await reserve("trattoria-sole", today, "19:00", 4, "party-plan");
  return { today, banquetDate, shops: seeded.map(shop => shop.slug) };
}
