// Page-owned business rules. Shared by manual controls and website_* actions.
import { canCheckReservations, reservationPageUrl, shopPageUrl } from "./shop-data.js";
export const COURSE_LABELS = { none: "Table only", wanted: "Course requested", any: "Either" };
export const ALLERGENS = {
  shrimp: "shrimp", crab: "crab", walnut: "walnut", wheat: "wheat",
  buckwheat: "buckwheat", egg: "egg", milk: "milk", peanut: "peanut",
};
export const allergenLabel = word => Object.hasOwn(ALLERGENS, word) ? ALLERGENS[word] : word;
const aliases = { えび: "shrimp", エビ: "shrimp", 海老: "shrimp", かに: "crab", カニ: "crab", くるみ: "walnut", 小麦: "wheat", そば: "buckwheat", 卵: "egg", 乳: "milk", 牛乳: "milk", 落花生: "peanut", ピーナッツ: "peanut" };
const clone = value => structuredClone(value);
const refuse = (reason, field) => ({ ok: false, reason, ...(field ? { field } : {}) });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max;
const identifier = value => text(value, 80) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);

// Tool calls may spell out "指定なし" instead of sending an empty string.
export function normalizeShopFilter(value = "") {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/\s/g, "");
  return /^(?:指定なし|指定無し|未指定|なし|おまかせ|どこでも|なんでも|何でも|こだわりなし|any|none|all|nopreference)$/.test(normalized) ? "" : value.trim();
}

export function japanNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(p => [p.type, p.value]));
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    todayLabel: new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full" }).format(now),
    currentTime: `${parts.hour}:${parts.minute}`, timeZone: "Asia/Tokyo",
  };
}

export function validateConditions(input, now = new Date()) {
  if (!object(input)) return refuse("予約条件を入力してください。");
  const allowed = ["date", "time", "partySize", "course", "budgetPerPerson", "avoid", "note"];
  if (Object.keys(input).some(key => !allowed.includes(key))) return refuse("扱えない条件が含まれています。");
  const { date, time, partySize, course = "any", budgetPerPerson, avoid = [], note = "" } = input;
  if (!text(date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse("日付を入力してください。", "date");
  const parsed = new Date(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(parsed.getTime()) || japanNow(parsed).today !== date) return refuse("実在する日付を入力してください。", "date");
  if (!text(time, 5) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return refuse("開始時刻を HH:MM 形式で入力してください。", "time");
  if (new Date(`${date}T${time}:00+09:00`) <= now) return refuse("これからの日時を指定してください（日本時間）。", "date");
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 200) return refuse("人数は1〜200名で入力してください。", "partySize");
  if (!Object.hasOwn(COURSE_LABELS, course)) return refuse("コースの要否を選んでください。", "course");
  if (budgetPerPerson !== undefined && (!Number.isInteger(budgetPerPerson) || budgetPerPerson < 1 || budgetPerPerson > 1000000)) return refuse("予算は1人あたり1〜1,000,000円で入力してください。", "budgetPerPerson");
  if (!Array.isArray(avoid) || avoid.length > 13) return refuse("避けたい食材は8品目と自由入力5個までです。", "avoid");
  const normalized = [];
  let freeCount = 0;
  for (const item of avoid) {
    if (!text(item, 20) || !item.trim() || /[\d@:/?#&=\n\r]|sk-|otk_|Bearer/i.test(item)) return refuse("食材は各20文字までで入力してください。連絡先やキーは入力しないでください。", "avoid");
    const word = item.trim();
    const value = Object.hasOwn(aliases, word) ? aliases[word] : word;
    if (normalized.includes(value)) continue;
    if (!Object.hasOwn(ALLERGENS, value)) freeCount += 1;
    if (freeCount > 5) return refuse("自由入力の食材は5個までです。", "avoid");
    normalized.push(value);
  }
  if (!text(note, 500)) return refuse("メモは500文字までです。", "note");
  return { ok: true, conditions: { date, time, partySize, course, ...(budgetPerPerson === undefined ? {} : { budgetPerPerson }), avoid: normalized, note } };
}

export class FinderPage {
  constructor(shops, { now = () => new Date(), navigate = url => globalThis.location.assign(url), onChange = () => {} } = {}) {
    this.shops = clone(shops);
    this.now = now;
    this.navigate = navigate;
    this.onChange = onChange;
    this.conditions = { date: "", time: "", partySize: 2, course: "any", avoid: [], note: "" };
    this.version = 0;
    this.candidates = [];
    this.introductions = [];
    this.introductionVersion = 0;
  }

  getState() {
    const validation = validateConditions(this.conditions, this.now());
    return clone({ ...japanNow(this.now()), conditions: this.conditions, version: this.version,
      valid: validation.ok, ...(validation.ok ? {} : { reason: validation.reason }), candidates: this.candidates, introductions: this.introductions, introductionVersion: this.introductionVersion });
  }

  listShops({ area = "", cuisine = "", query = "", purpose = "introduction" } = {}) {
    const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s/g, "").replace(/ネイルサロン/g, "ネイル");
    const place = normalize(normalizeShopFilter(area));
    const genre = normalize(normalizeShopFilter(cuisine)).replace(/料理$/, "");
    const terms = query.trim().split(/\s+/).filter(Boolean).map(normalize);
    return clone(this.shops.filter(shop => (purpose !== "reservation" || canCheckReservations(shop)) && (!place || normalize(shop.area).includes(place))
      && (!genre || normalize(shop.cuisine).includes(genre)) && terms.every(term => normalize(`${shop.name} ${shop.cuisine} ${shop.description || ""}`).includes(term))));
  }

  showIntroductions({ shopIds } = {}) {
    if (!Array.isArray(shopIds) || shopIds.length > this.shops.length || new Set(shopIds).size !== shopIds.length || shopIds.some(id => !this.shops.some(shop => shop.id === id))) return refuse("登録店のIDを重複なく指定してください。");
    this.introductions = clone(shopIds);
    this.introductionVersion += 1;
    this.candidates = [];
    this.onChange("introductions");
    return { ok: true, count: shopIds.length, shops: clone(shopIds.map(id => this.shops.find(shop => shop.id === id))) };
  }

  setConditions(input) {
    const result = validateConditions(input, this.now());
    if (!result.ok) return result;
    this.conditions = result.conditions;
    this.version += 1;
    this.candidates = [];
    this.onChange("conditions");
    return { ok: true, ...this.getState() };
  }

  // Manual edits invalidate results immediately, including an incomplete draft.
  editConditions(draft) {
    this.conditions = clone(draft);
    this.version += 1;
    this.candidates = [];
    this.onChange("draft");
    return this.getState();
  }

  showCandidates({ candidates, expectedVersion } = {}) {
    if (!Number.isInteger(expectedVersion) || expectedVersion !== this.version) return refuse("条件が変わりました。最新の条件で確認し直してください。");
    if (!validateConditions(this.conditions, this.now()).ok) return refuse("先に日時と人数を入力してください。");
    if (!Array.isArray(candidates) || candidates.length > this.shops.length) return refuse("比較する店を確認してください。");
    const ids = new Set();
    const allowed = ["shopId", "status", "remaining", "durationMinutes", "seatOnly", "courseId", "courseName", "priceText", "avoidResult", "summary"];
    for (const candidate of candidates) {
      if (!object(candidate) || Object.keys(candidate).some(key => !allowed.includes(key))) return refuse("比較結果の形式が正しくありません。");
      if (!this.shops.some(shop => shop.id === candidate.shopId) || ids.has(candidate.shopId)) return refuse("登録店のIDを重複なく指定してください。");
      if (!canCheckReservations(this.shops.find(shop => shop.id === candidate.shopId))) return refuse("予約情報を取得できない店は、店舗紹介として案内してください。");
      ids.add(candidate.shopId);
      if (!["available", "full", "unknown", "declined"].includes(candidate.status)) return refuse("確認結果の状態が正しくありません。");
      if (!text(candidate.summary, 1000) || !candidate.summary.trim()) return refuse("根拠となる店の回答を要約してください。");
      for (const key of ["remaining", "durationMinutes"]) {
        if (candidate[key] !== undefined && (!Number.isInteger(candidate[key]) || candidate[key] < 0 || candidate[key] > 10000)) return refuse("席数と利用時間は0以上の整数で指定してください。");
      }
      if (candidate.seatOnly !== undefined && typeof candidate.seatOnly !== "boolean") return refuse("席のみ可否の形式が正しくありません。");
      if (candidate.courseId !== undefined && !identifier(candidate.courseId)) return refuse("コースIDの形式が正しくありません。");
      for (const key of ["courseName", "priceText", "avoidResult"]) {
        if (candidate[key] !== undefined && !text(candidate[key], key === "avoidResult" ? 1000 : 200)) return refuse("店の回答が長すぎます。");
      }
    }
    this.candidates = clone(candidates);
    this.onChange("candidates");
    return { ok: true, count: candidates.length, version: this.version };
  }

  clearCandidates() {
    this.candidates = [];
    this.introductions = [];
    this.onChange("candidates");
  }

  checkOpenShop({ shopId, courseId, expectedVersion } = {}) {
    if (!Number.isInteger(expectedVersion) || expectedVersion !== this.version) return refuse("条件が変わりました。最新の条件を確認してから、もう一度選んでください。");
    const validation = validateConditions(this.conditions, this.now());
    if (!validation.ok) return validation;
    const shop = this.shops.find(item => item.id === shopId);
    if (!shop) return refuse("登録されている店を選んでください。");
    if (!canCheckReservations(shop)) return refuse("この店の予約情報は取得できません。店舗サイトをご覧ください。");
    const candidate = this.candidates.find(item => item.shopId === shopId);
    if (courseId !== undefined && (!identifier(courseId) || candidate?.courseId !== courseId || candidate.status !== "available")) return refuse("確認できたコースを選んでください。");
    const c = validation.conditions;
    if (c.course === "none" && courseId) return refuse("席のみの予約ではコースを指定できません。");
    const url = new URL(reservationPageUrl(shop));
    const hash = new URLSearchParams({ aw: "v1", date: c.date, time: c.time, people: String(c.partySize), course: c.course });
    if (c.budgetPerPerson !== undefined) hash.set("budget", String(c.budgetPerPerson));
    if (c.avoid.length) hash.set("avoid", c.avoid.join(","));
    if (courseId) hash.set("course_id", courseId);
    // An explicit allowlist: never copy note, chat, provider settings or keys.
    url.hash = hash.toString();
    return { ok: true, url: url.href, shop: clone(shop), conditions: clone(c) };
  }

  /**
   * The shop's page as this site frames it: with the current conditions in the fragment when they
   * are complete, and the plain page otherwise. The same allowlist as a move to the shop's site.
   */
  framedShopUrl(shopId, target = "reserve", courseId) {
    const shop = this.shops.find(item => item.id === shopId);
    if (!shop) return refuse("登録されている店を選んでください。");
    if (target === "reserve" && !canCheckReservations(shop)) return refuse("この店の予約情報は取得できません。店舗サイトをご覧ください。");
    const page = new URL(target === "shop" ? shopPageUrl(shop) : reservationPageUrl(shop));
    if (!canCheckReservations(shop)) return { url: page.href, conditions: null };
    const validation = validateConditions(this.conditions, this.now());
    if (!validation.ok) return { url: page.href, conditions: null };
    const c = validation.conditions;
    const url = new URL(page.href);
    const hash = new URLSearchParams({ aw: "v1", date: c.date, time: c.time, people: String(c.partySize), course: c.course });
    if (c.budgetPerPerson !== undefined) hash.set("budget", String(c.budgetPerPerson));
    if (c.avoid.length) hash.set("avoid", c.avoid.join(","));
    if (target === "reserve" && courseId && this.checkOpenShop({ shopId, courseId, expectedVersion: this.version }).ok) hash.set("course_id", courseId);
    url.hash = hash.toString();
    const { note: _note, ...shared } = c;
    return { url: url.href, conditions: clone(shared) };
  }

  openShopPage(args) {
    const check = this.checkOpenShop(args);
    if (!check.ok) return check;
    // Return the receipt to the runtime before the scheduled navigation occurs.
    this.navigate(check.url);
    return { ok: true, url: check.url };
  }
}
