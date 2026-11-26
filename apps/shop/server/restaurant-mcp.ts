import { z } from "zod";
import { getLocale, tr } from "../shared/i18n.ts";
import { currencyOf, formatMoney, regionOf, weekdayOf } from "../shared/region.ts";
import { allergenWords } from "../shared/allergens.ts";
import type { Booking, ShopConfig } from "./domain.ts";
import { durationFor, isLargeParty, reservableCourse, seatAvailability, seatProblemText, seatingProblem } from "./seats.ts";
import { hoursText, publishedProducts, specialDaysText } from "./domain.ts";

// The restaurant's read-only tools for agents: open seats, and what the menu contains.
// They return counts and menu facts only: never a guest's name, contact or reservation.

const menuId = z.string().regex(/^[a-z0-9_-]+$/).max(60);
const checkAvailabilityInput = z.object({
  date: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  partySize: z.number().int().min(1).max(200),
  courseId: menuId.optional(),
}).strict();
const findMenuItemsInput = z.object({
  kind: z.enum(["course", "dish", "drink", "any"]).default("any"),
  partySize: z.number().int().min(1).max(200).optional(),
  budgetPerPerson: z.number().min(0).max(1000000).optional(),
  avoid: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
}).strict();

export const restaurantTools = [
  {
    name: "check_availability",
    title: "Check open seats",
    description: "Seats this restaurant can still reserve on a date for a party. Give the start time to ask about that time; leave it out to get every start time of the date. Returns the seats left at each start time, whether the party fits, how long the seats are held, and whether a reservation for seats only (no course) is accepted. Read-only: it reserves nothing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["date", "partySize"],
      properties: {
        date: { type: "string", format: "date", description: "The date as YYYY-MM-DD, in the restaurant's time zone." },
        time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "The start time as HH:MM (24-hour)." },
        partySize: { type: "integer", minimum: 1, maximum: 200, description: "How many guests." },
        courseId: { type: "string", description: "A course id from find_menu_items, when a course is chosen. Leave out for seats only." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "find_menu_items",
    title: "Find courses, dishes and drinks",
    description: "This restaurant's courses, dishes and drinks with their prices, ingredients and allergens. Filter by kind, by party size and by budget per person (both apply to courses), and give foods to avoid to have each item judged: \"contains\" (the ingredient or allergen list names it), \"not_listed\" (the lists do not name it, which is not a promise that it is absent) or \"unknown\". Only an item of kind \"course\" can be chosen with a reservation. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["course", "dish", "drink", "any"], description: "Which kind of item; any by default." },
        partySize: { type: "integer", minimum: 1, maximum: 200, description: "Only courses that this many guests can order." },
        budgetPerPerson: { type: "number", minimum: 0, description: "Only courses at or under this price per person." },
        avoid: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 }, description: "Foods to avoid, in English or Japanese, such as \"shrimp\"." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_shop_info",
    title: "Shop information and reservation conditions",
    description: "This restaurant's name, introduction, address, opening hours and closed days, and the conditions it publishes for reservations: party sizes, start times, how long seats are held, how far ahead and how late a reservation can be made, the cancellation rule and how to pay. Facilities are known only when the introduction mentions them. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

/** Lower case, with katakana folded to hiragana, so えび, エビ and Shrimp compare equal to their list entries. */
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60)).trim();
const asciiWord = /^[a-z]+$/;
/**
 * The labelled allergens a food names. A Japanese word counts when it appears anywhere in the food
 * ("甘えび" names えび); an English one only as a whole word, so "eggplant" does not name egg.
 */
const allergensOf = (food: string) => {
  const tokens = food.split(/[^a-z]+/).filter(Boolean);
  return (Object.keys(allergenWords) as (keyof typeof allergenWords)[]).filter(id =>
    allergenWords[id].some(word => asciiWord.test(word) ? tokens.includes(word) : food.includes(word)));
};
export type AvoidResult = "contains" | "not_listed" | "unknown";
/** Judge one food against one menu item, from its ingredient and allergen lists alone. */
export function matchAvoid(menu: Pick<ShopConfig["menus"][number], "ingredients" | "allergens">, food: string): AvoidResult {
  const word = fold(food);
  // One letter or character matches far too much to mean anything, except a kanji such as 卵.
  if (!word || (word.length < 2 && !/[\u4e00-\u9fff]/.test(word))) return "unknown";
  if (!menu.ingredients?.length) return "unknown";
  const allergens = allergensOf(word);
  if (allergens.some(id => menu.allergens?.includes(id))) return "contains";
  // Any way of writing the allergen in an ingredient counts, and so does the food's own word.
  const words = [word, ...allergens.flatMap(id => allergenWords[id])];
  const names = (ingredient: string, candidate: string) => asciiWord.test(candidate) ? ingredient.split(/[^a-z]+/).includes(candidate) : ingredient.includes(candidate);
  return menu.ingredients.some(ingredient => words.some(candidate => names(fold(ingredient), candidate))) ? "contains" : "not_listed";
}
const worst = (results: AvoidResult[]): AvoidResult => results.includes("contains") ? "contains" : results.includes("unknown") ? "unknown" : "not_listed";

const clockIn = (instant: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function checkAvailability(config: ShopConfig, bookings: readonly Booking[], reservePageUrl: string, rawInput: unknown, now = new Date()) {
  const input = checkAvailabilityInput.parse(rawInput);
  const timeZone = regionOf(config).timeZone;
  const problem = seatingProblem(config, input.date, input.partySize, input.courseId, now);
  const all = seatAvailability(config, bookings, input.date, input.partySize, input.courseId, now)
    .map(slot => ({ start: clockIn(slot.start, timeZone), remaining: slot.remaining, fits: slot.fits }));
  const asked = input.time ? all.filter(slot => slot.start === input.time) : all;
  const reason = problem ? seatProblemText(problem, config, input.courseId)
    : input.time && !asked.length ? tr("この時刻は予約できません") : undefined;
  return {
    shop: config.name,
    date: input.date,
    weekday: weekdayNames[weekdayOf(input.date)],
    partySize: input.partySize,
    durationMinutes: durationFor(config, input.partySize, input.courseId),
    reservationType: isLargeParty(config, input.partySize) ? "large_party" as const : "standard" as const,
    seatOnlyAllowed: !!config.seating?.seatOnly,
    ...(input.courseId ? { course: reservableCourse(config, input.courseId)?.name ?? null } : {}),
    slots: asked,
    // When one time was asked about, the other times of the date that still fit this party.
    ...(input.time ? { otherTimesThatFit: all.filter(slot => slot.fits && slot.start !== input.time).map(slot => slot.start) } : {}),
    closed: problem === "closed",
    ...(reason ? { reason } : {}),
    reservePageUrl,
    // Seats change: this is what was open at this moment, not a hold.
    checkedAt: now.toISOString(),
  };
}

export function shopInfo(config: ShopConfig, reservePageUrl: string, rawInput: unknown = {}, now = new Date()) {
  z.object({}).strict().parse(rawInput ?? {});
  const seating = config.seating;
  const today = now.toISOString().slice(0, 10);
  const weekdays = weekdayNames;
  return {
    shop: config.name,
    description: config.description,
    address: config.address,
    timeZone: regionOf(config).timeZone,
    hours: {
      regular: hoursText(config),
      closedWeekdays: config.hours.closedWeekdays.map(day => weekdays[day]),
      closedDates: config.hours.holidays.filter(date => date >= today).sort().slice(0, 30),
      specialDays: specialDaysText({ ...config, staff: [] }),
    },
    catalog: publishedProducts(config),
    reservation: seating ? {
      partySize: { min: seating.minPartySize, max: seating.maxPartySize },
      seatOnlyAllowed: seating.seatOnly,
      startTimes: [...seating.startTimes].sort(),
      standardMinutes: seating.standardMinutes,
      largePartyMinutes: seating.largePartyMinutes,
      largePartyFrom: seating.largePartyFrom,
      advanceDays: config.rules.advanceDays,
      sameDay: config.rules.sameDay,
      leadMinutes: config.rules.leadMinutes,
      cancellation: tr("キャンセルは開始の{0}時間前まで受け付けます。", config.rules.cancelHours),
      payment: tr("お支払いは当日お店で。オンライン決済はありません。"),
    } : null,
    facilities: tr("設備の情報は、お店の紹介文に書かれている範囲だけです。"),
    reservePageUrl,
    checkedAt: now.toISOString(),
  };
}

export function findMenuItems(config: ShopConfig, rawInput: unknown, now = new Date()) {
  const input = findMenuItemsInput.parse(rawInput);
  const currency = currencyOf(regionOf(config));
  const japanese = getLocale() === "ja";
  const money = (amount: number) => currency === "JPY" && japanese ? tr("{0}円", amount.toLocaleString("en-US")) : formatMoney(amount, currency, "en-US");
  const items = config.menus
    .filter(menu => menu.active && !menu.optionFor && menu.kind)
    .filter(menu => input.kind === "any" || menu.kind === input.kind)
    .filter(menu => menu.kind !== "course" || (
      (input.partySize === undefined || (input.partySize >= (menu.minPeople ?? 1) && input.partySize <= (menu.maxPeople ?? Infinity))) &&
      (input.budgetPerPerson === undefined || menu.price <= input.budgetPerPerson)))
    .map(menu => {
      const avoid = input.avoid.map(food => ({ food, result: matchAvoid(menu, food) }));
      return {
        id: menu.id,
        kind: menu.kind!,
        name: menu.name,
        price: menu.price,
        priceText: menu.kind === "course" ? tr("{0}/人", money(menu.price)) : money(menu.price),
        ...(menu.kind === "course" ? { minPeople: menu.minPeople ?? 1, ...(menu.maxPeople ? { maxPeople: menu.maxPeople } : {}), ...(menu.courseMinutes ? { courseMinutes: menu.courseMinutes } : {}) } : {}),
        ingredients: menu.ingredients || [],
        allergens: menu.allergens || [],
        allergenNote: menu.allergenNote || "",
        ...(avoid.length ? { matchesAvoid: worst(avoid.map(entry => entry.result)), avoid } : {}),
      };
    });
  return {
    shop: config.name,
    currency,
    items,
    note: tr("材料表とアレルゲン表示だけから判定しています。アレルギーはお店に直接ご確認ください。"),
    checkedAt: now.toISOString(),
  };
}

export function callRestaurantTool(name: string, args: unknown, context: { config: ShopConfig; bookings: () => Promise<readonly Booking[]>; reservePageUrl: string }) {
  if (name === "check_availability") return context.bookings().then(bookings => checkAvailability(context.config, bookings, context.reservePageUrl, args));
  if (name === "find_menu_items") return Promise.resolve(findMenuItems(context.config, args));
  if (name === "get_shop_info") return Promise.resolve(shopInfo(context.config, context.reservePageUrl, args));
  return undefined;
}
