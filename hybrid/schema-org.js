// Published shop facts as schema.org JSON-LD (https://schema.org/Restaurant).
// One vocabulary serves the on-device prompt, the town MCP and the storefront <head>.
// Published list prices are included on request ({ prices: true }) and copied unchanged by
// code. The storefront <head>, the town MCP and the on-device prompt all use it, so a model
// may quote a listed price as published but never calculates a total (see GROUNDING in
// policy.js). Totals, availability and booking prices stay with the shop's deterministic tools.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ALIASES = new Map([
  ...DAYS.map((day, index) => [day.toLowerCase(), index]),
  ...DAYS.map((day, index) => [day.slice(0, 3).toLowerCase(), index]),
  ..."日月火水木金土".split("").flatMap((day, index) => [[day, index], [`${day}曜`, index], [`${day}曜日`, index]]),
]);
const TIME = "(\\d{1,2}):(\\d{2})";
const DASH = "\\s*[-–—~〜]\\s*";
const RANGE = new RegExp(`^${TIME}${DASH}${TIME}$`);
const DAY_RANGE = new RegExp(`^(\\S+)\\s+${TIME}${DASH}${TIME}$`);
// The shop's own special-day text may end with a staff note such as "（出勤：…）".
const DATE_RANGE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s+${TIME}${DASH}${TIME}(?:\\s*[（(].*)?$`);
const BUSINESS_TYPES = { restaurant: "Restaurant", hair: "HairSalon", nail: "NailSalon" };

const text = (value, max = 500) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
/** "9:05" → "09:05"; null for anything that is not a time of day (24:00 is allowed as a closing time). */
const clock = (hours, minutes) => {
  const h = Number(hours), m = Number(minutes);
  return (h < 24 && m < 60) || (h === 24 && m === 0) ? `${String(h).padStart(2, "0")}:${minutes}` : null;
};
const range = (match, from) => {
  const start = match && clock(match[from], match[from + 1]);
  const end = match && clock(match[from + 2], match[from + 3]);
  return start && end ? { start, end } : null;
};
const dayIndex = value => Number.isInteger(value) && value >= 0 && value <= 6 ? value
  : typeof value === "string" ? DAY_ALIASES.get(value.trim().toLowerCase()) : undefined;
const isoDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Parses the shops' own hours text ("17:00 – 23:30", optionally followed by
 * " / Mon 17:00 – 22:00" or " / 月曜 17:00 – 22:00") into a default range and
 * per-weekday overrides. Returns null when any part is not in that form.
 */
export function parseHoursText(value) {
  const parts = String(value || "").split("/").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const base = range(parts[0].match(RANGE), 1);
  if (!base) return null;
  const weekdayHours = [];
  for (const part of parts.slice(1)) {
    const match = part.match(DAY_RANGE);
    const day = match ? dayIndex(match[1]) : undefined;
    const hours = range(match, 2);
    if (day === undefined || !hours) return null;
    weekdayHours.push({ day, ...hours });
  }
  return { ...base, weekdayHours };
}

/** Special opening days as [{ date, start, end }], from the config array or the shops' " / "-joined text. */
function specialDays(value) {
  const entries = Array.isArray(value) ? value
    : typeof value === "string" ? value.split(" / ").map(part => {
      const match = part.trim().match(DATE_RANGE);
      return match && { date: match[1], ...range(match, 2) };
    }) : [];
  return entries.flatMap(entry => {
    const hours = entry && isoDate(entry.date) && range(`${entry.start}-${entry.end}`.match(RANGE), 1);
    return hours ? [{ date: entry.date, ...hours }] : [];
  });
}

const spec = (fields, opens, closes) => ({ "@type": "OpeningHoursSpecification", ...fields, opens, closes });
const dayList = days => days.length === 1 ? days[0] : days;

/**
 * Builds OpeningHoursSpecification entries: days that share times are grouped,
 * closed weekdays and closed dates are explicit (schema.org marks closed with
 * opens and closes both at 00:00) and special days carry their own times.
 * Returns weekly and date-specific specs separately. When regular hours cannot be parsed, the
 * weekly entries are left out but closures and special days are still kept.
 */
export function openingHoursSpecification(hours) {
  const regular = typeof hours === "string" ? hours : hours?.regular;
  const parsed = parseHoursText(regular);
  const closed = [...new Set((Array.isArray(hours?.closedWeekdays) ? hours.closedWeekdays : [])
    .map(dayIndex).filter(day => day !== undefined))].sort();
  const weekly = [];
  if (parsed) {
    const overrides = new Map(parsed.weekdayHours.map(entry => [entry.day, entry]));
    for (const entry of Array.isArray(hours?.weekdayHours) ? hours.weekdayHours : []) {
      const day = dayIndex(entry?.day);
      const times = range(`${entry?.start}-${entry?.end}`.match(RANGE), 1);
      if (day !== undefined && times) overrides.set(day, times);
    }
    const groups = new Map();
    for (let day = 0; day < 7; day++) {
      if (closed.includes(day)) continue;
      const { start, end } = overrides.get(day) || parsed;
      const key = `${start}|${end}`;
      if (!groups.has(key)) groups.set(key, { start, end, days: [] });
      groups.get(key).days.push(DAYS[day]);
    }
    for (const { start, end, days } of groups.values()) weekly.push(spec({ dayOfWeek: dayList(days) }, start, end));
  }
  if (closed.length) weekly.push(spec({ dayOfWeek: dayList(closed.map(day => DAYS[day])) }, "00:00", "00:00"));
  const closedDates = [...new Set((Array.isArray(hours?.closedDates) ? hours.closedDates : []).filter(isoDate))].sort();
  const special = specialDays(hours?.specialDays).sort((a, b) => a.date.localeCompare(b.date));
  const exceptions = [
    ...closedDates.map(date => spec({ validFrom: date, validThrough: date }, "00:00", "00:00")),
    ...special.map(({ date, start, end }) => spec({ validFrom: date, validThrough: date }, start, end)),
  ];
  return { weekly, exceptions, parsed: Boolean(parsed) };
}

const listPrice = product => Number.isFinite(product?.price) && product.price >= 0
  && typeof product.currency === "string" && /^[A-Z]{3}$/.test(product.currency)
  ? { price: product.price, priceCurrency: product.currency } : null;

function offeredItems(products, defaultType, prices) {
  // Items with an ID are told apart by it, so same-name items with different prices both stay.
  // A name-only entry (a basic product name) is dropped when an item with an ID has that name.
  const byKey = new Map();
  const items = [];
  for (const product of Array.isArray(products) ? products : []) {
    const name = text(typeof product === "string" ? product : product?.name, 120);
    if (!name) continue;
    const type = ["MenuItem", "Product", "Service"].includes(product?.type) ? product.type : defaultType;
    const id = text(product?.id, 200);
    const key = id ? `id:${id}` : `name:${type}:${name}`;
    const price = prices ? listPrice(product) : null;
    if (byKey.has(key)) { const entry = byKey.get(key); entry.price ||= price; continue; }
    const entry = { item: { "@type": type, name }, price, id, nameKey: `${type}:${name}` };
    byKey.set(key, entry);
    items.push(entry);
  }
  const withId = new Map(items.filter(entry => entry.id).map(entry => [entry.nameKey, entry]));
  return items.filter(entry => {
    if (entry.id || !withId.has(entry.nameKey)) return true;
    withId.get(entry.nameKey).price ||= entry.price;
    return false;
  }).map(({ item, price }) => ({ item, price }));
}

/**
 * Builds a schema.org Restaurant (or HairSalon, NailSalon, LocalBusiness) from published facts only.
 * Accepts the town registry shape (hours as text, products as strings) and the
 * storefront facts.json shape (hours object, products as { name, type }).
 * Unknown keys, staff and reservations are never copied; list prices only with { prices: true }.
 */
export function shopJsonLd(facts, { context = true, industry, prices = false } = {}) {
  if (!facts || typeof facts !== "object") return null;
  const name = text(facts.name, 200);
  if (!name) return null;
  const cuisine = text(facts.cuisine, 200);
  const industryKey = industry ?? facts.industry;
  const type = Object.hasOwn(BUSINESS_TYPES, industryKey) ? BUSINESS_TYPES[industryKey] : "LocalBusiness";
  const defaultItemType = type === "Restaurant" ? "MenuItem" : type === "LocalBusiness" ? "Product" : "Service";
  const items = offeredItems(facts.products, defaultItemType, prices);
  const offer = price => ({ "@type": "Offer", ...price });
  const menu = items.filter(({ item }) => item["@type"] === "MenuItem")
    .map(({ item, price }) => price ? { ...item, offers: offer(price) } : item);
  const offers = items.filter(({ item }) => item["@type"] !== "MenuItem")
    .map(({ item, price }) => ({ ...offer(price), itemOffered: item }));
  const hours = openingHoursSpecification(facts.hours);
  const regular = typeof facts.hours === "string" ? facts.hours : facts.hours?.regular;
  const area = text(facts.area, 200);
  const url = text(facts.pageUrl, 500);
  const reservationUrl = text(facts.reservationUrl, 500);
  return {
    ...(context ? { "@context": "https://schema.org" } : {}),
    "@type": type,
    ...(text(facts.id, 100) ? { identifier: text(facts.id, 100) } : {}),
    name,
    ...(text(facts.description, 2000) ? { description: text(facts.description, 2000) } : {}),
    // The registry's category is a cuisine only for restaurants; other shops keep it as a keyword.
    ...(cuisine ? type === "Restaurant" ? { servesCuisine: cuisine } : { keywords: cuisine } : {}),
    ...(text(facts.address) ? { address: text(facts.address) } : {}),
    ...(area ? { containedInPlace: { "@type": "Place", name: area } } : {}),
    ...(url ? { url } : {}),
    // Text the parser cannot read stays as text beside whatever closures could be read.
    ...(!hours.parsed && text(regular) ? { openingHours: text(regular) } : {}),
    ...(hours.weekly.length ? { openingHoursSpecification: hours.weekly } : {}),
    ...(hours.exceptions.length ? { specialOpeningHoursSpecification: hours.exceptions } : {}),
    ...(menu.length ? { hasMenu: { "@type": "Menu", hasMenuItem: menu } } : {}),
    ...(offers.length ? { makesOffer: offers } : {}),
    ...(facts.reservationEnabled === true ? { acceptsReservations: reservationUrl || true }
      : facts.reservationEnabled === false ? { acceptsReservations: false } : {}),
  };
}

/** Serializes JSON-LD for an inline <script type="application/ld+json"> element. */
export function jsonLdScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
