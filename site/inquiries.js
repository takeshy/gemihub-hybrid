import { allergenLabel, COURSE_LABELS, normalizeShopFilter } from "./finder.js";
import { hasAgent } from "./shop-data.js";

const BATCH_SIZE = 4;
const ASK_PREFERENCES_AT = 15;

// Approval belongs to one search and its exact destinations, never an entire host
// forever. The runtime remains responsible for fetching and executing the peers.
export class ShopInquiries {
  constructor(getPage, review, getUserMessage = () => "") {
    this.getPage = getPage;
    this.review = review;
    this.getUserMessage = getUserMessage;
    this.preferences = { cuisine: null, area: null };
    this.approved = null;
    this.pending = null;
  }

  invalidate() {
    this.approved = null;
    this.pending?.abort();
  }

  reset() {
    this.invalidate();
    this.preferences = { cuisine: null, area: null };
  }

  async confirm({ cuisine, area, expectedVersion, offset = 0, purpose = "reservation", query = "" } = {}) {
    if (this.pending) return { ok: false, reason: "確認先の確認に回答してください。" };
    const page = this.getPage();
    const state = page.getState();
    if (!["reservation", "introduction"].includes(purpose)) return { ok: false, reason: "問い合わせの目的を確認してください。" };
    if (expectedVersion !== state.version || (purpose === "reservation" && !state.valid)) return { ok: false, reason: "最新の条件を確認してください。予約の問い合わせには日時・人数が必要です。" };
    if (typeof query !== "string" || query.length > 140 || (purpose === "introduction" && !query.trim())) return { ok: false, reason: "問い合わせる内容を140文字以内で指定してください。" };
    if (![cuisine, area].every(value => typeof value === "string" && value.length <= 80)) {
      return { ok: false, reason: "ジャンル・場所は文字列で渡してください。指定なしの場合は空文字を使ってください。" };
    }
    const previous = this.activePlan();
    this.approved = null;
    if (!Number.isInteger(offset) || offset < 0) return { ok: false, reason: "確認する範囲が正しくありません。" };
    const text = this.getUserMessage().normalize("NFKC").replace(/\s/g, "");
    const any = /^(おまかせ|指定なし)(で|です|お願いします|でお願いします|でいいです|で良いです)?[。.!！]*$/.test(text)
      || /^(?:おまかせ[・、,/]?どこでも|どこでも[・、,/]?おまかせ)(?:で(?:す|お願いします|いいです|良いです)|いいです|良いです)?[。.!！]*$/.test(text);
    const unrestricted = field => any || new RegExp(`${field === "cuisine" ? "(?:ジャンル|料理|食事)" : "(?:場所|地域|エリア)"}.{0,12}(?:指定なし|おまかせ|何でも|なんでも|どこでも|問わない|こだわり.{0,3}(?:ない|なし|ありません))`).test(text);
    const resolve = (field, value) => value.trim() ? normalizeShopFilter(value) : (unrestricted(field) ? "" : this.preferences[field]);
    const preferences = { cuisine: resolve("cuisine", cuisine), area: resolve("area", area) };
    const matches = page.listShops({ cuisine: preferences.cuisine ?? "", area: preferences.area ?? "", purpose }).filter(hasAgent);
    this.preferences = preferences;
    if (matches.length >= ASK_PREFERENCES_AT && Object.values(preferences).some(value => value === null)) {
      return { ok: false, count: matches.length, needsPreferences: true,
        missingPreferences: Object.keys(preferences).filter(field => preferences[field] === null),
        reason: "候補が15店以上あります。未指定のジャンル・場所だけをチャットで聞いてください。指定なしでも進められます。" };
    }
    if (!matches.length) return { ok: false, count: 0, reason: "その条件で問い合わせられるエージェントはありません。登録済みの紹介文や店舗サイトから案内できます。" };
    if (offset && (!previous || previous.nextOffset !== offset || previous.cuisine !== preferences.cuisine || previous.area !== preferences.area || previous.purpose !== purpose || previous.query !== query)) {
      return { ok: false, reason: "条件が変わったか、続きがありません。offset=0で件数を確認し直してください。" };
    }
    if (!offset) page.clearCandidates();
    const shops = matches.slice(offset, offset + BATCH_SIZE);
    const nextOffset = offset + shops.length < matches.length ? offset + shops.length : null;
    const plan = { ...preferences, purpose, query, expectedVersion, conditions: state.conditions, shops, count: shops.length,
      totalCount: matches.length, offset, nextOffset, hasMore: nextOffset !== null };
    const controller = new AbortController();
    this.pending = controller;
    try {
      const accepted = await this.review(plan, controller.signal);
      if (controller.signal.aborted || this.getPage().version !== expectedVersion) {
        return { ok: false, reason: "条件が変わりました。確認先を確認し直してください。" };
      }
      if (accepted !== true) return { ok: true, approved: false, count: plan.count, reason: "店への問い合わせは行っていません。希望を確認してください。" };
      this.approved = plan;
      return { ok: true, approved: true, ...this.batchState(), shops, version: expectedVersion };
    } finally {
      if (this.pending === controller) this.pending = null;
    }
  }

  activePlan() {
    return this.approved?.expectedVersion === this.getPage().version ? this.approved : null;
  }

  batchState() {
    const plan = this.activePlan();
    if (!plan) return null;
    const { count, totalCount, offset, nextOffset, hasMore } = plan;
    return { count, totalCount, offset, nextOffset, hasMore, purpose: plan.purpose, query: plan.query };
  }

  canContactNetwork(url) {
    return this.activePlan()?.shops.some(shop => shop.networkUrl === url) || false;
  }

  canContactMcp(ref) {
    try {
      const url = new URL(typeof ref === "string" ? ref : ref.url);
      return this.activePlan()?.shops.some(shop => new URL(shop.networkUrl).origin === url.origin) || false;
    } catch { return false; }
  }

  decision(info) {
    if (!["network", "mcp"].includes(info.kind)) return "decline";
    return this.activePlan()?.shops.some(shop => new URL(shop.networkUrl).host === info.peerOrigin) ? "allow" : "decline";
  }
}

export function installInquiryPolicy(engine, inquiries) {
  engine.consent.clear();
  engine.onConsent = info => inquiries.decision(info);
  const resolveRemote = engine.resolveRemote.bind(engine);
  engine.resolveRemote = (url, ...args) => {
    if (!inquiries.canContactNetwork(url)) throw new Error("先に確認先の件数を確認してください。");
    return resolveRemote(url, ...args);
  };
  const resolveMcp = engine.resolveMcp.bind(engine);
  engine.resolveMcp = (ref, ...args) => {
    if (!inquiries.canContactMcp(ref)) throw new Error("確認した確認先に含まれない接続先です。");
    const plan = inquiries.activePlan();
    if (plan?.purpose !== "introduction") return resolveMcp(ref, ...args);
    return Promise.resolve(resolveMcp(ref, ...args)).then(client => {
      const allowed = new Set();
      const check = () => { if (inquiries.activePlan() !== plan) throw new Error("問い合わせ先をもう一度確認してください。"); };
      return {
        listTools: async (...params) => {
          check();
          const tools = (await client.listTools(...params)).filter(tool => tool.annotations?.readOnlyHint === true || ["get_shop_info", "check_availability", "find_menu_items"].includes(tool.name));
          for (const tool of tools) allowed.add(tool.name);
          return tools;
        },
        callTool: (name, ...params) => {
          check();
          if (!allowed.has(name)) throw new Error("店舗紹介では読み取り専用の問い合わせだけを利用できます。");
          return client.callTool(name, ...params);
        },
      };
    });
  };
}

export function reviewShopInquiries(plan, signal) {
  return new Promise(resolve => {
    const messages = document.getElementById("ns-msgs");
    const card = document.createElement("div");
    card.className = "ns-msg bot finder-inquiry";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Confirm which shops to contact");
    const title = document.createElement("p");
    title.className = "finder-inquiry-title";
    const topic = plan.purpose === "introduction" ? "shop and product details" : "availability and menus";
    const count = `${plan.count} ${plan.count === 1 ? "shop" : "shops"}`;
    title.textContent = plan.totalCount > plan.count
      ? `${plan.totalCount} shops match. Ask the ${plan.offset ? "next" : "first"} ${count} about ${topic}?`
      : `Ask ${count} about ${topic}?`;
    const summary = document.createElement("p");
    const c = plan.conditions;
    const filters = `${plan.cuisine || "Any category"} / ${plan.area || "Any area"}`;
    summary.textContent = plan.purpose === "introduction"
      ? `${filters} · ${plan.query}`
      : `${filters} · ${c.date} ${c.time} / Guests: ${c.partySize} / ${COURSE_LABELS[c.course]}`
        + (c.budgetPerPerson ? ` / ¥${c.budgetPerPerson.toLocaleString("en-US")} per person` : "")
        + (c.avoid.length ? ` / Foods to avoid: ${c.avoid.map(allergenLabel).join(", ")}` : "");
    const targets = document.createElement("p");
    targets.textContent = plan.shops.map(shop => shop.name).join(", ");
    const origins = document.createElement("small");
    origins.textContent = [...new Set(plan.shops.map(shop => new URL(shop.networkUrl).origin))].join(", ");
    const buttons = document.createElement("div");
    buttons.className = "finder-inquiry-actions";
    const yes = document.createElement("button");
    yes.type = "button"; yes.textContent = "Ask these shops";
    const no = document.createElement("button");
    no.type = "button"; no.textContent = "Change search";
    const finish = accepted => {
      signal.removeEventListener("abort", abort);
      buttons.remove();
      title.textContent = signal.aborted ? "The search changed. Review the shops again."
        : accepted ? `Asking ${count} about ${topic}…` : "Search canceled. You can change your preferences.";
      document.getElementById("ns-input")?.focus();
      resolve(accepted);
    };
    const abort = () => finish(false);
    yes.addEventListener("click", () => finish(true), { once: true });
    no.addEventListener("click", () => finish(false), { once: true });
    signal.addEventListener("abort", abort, { once: true });
    buttons.append(yes, no);
    card.append(title, summary, targets, origins, buttons);
    messages.append(card);
    messages.scrollTop = messages.scrollHeight;
    if (signal.aborted) finish(false);
  });
}
