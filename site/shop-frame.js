// One shop's own page, shown inside this site. The shop's assistant runs in that page;
// its model requests use its own Firebase hybrid adapter. The visitor talks to
// the shop and reserves in the shop's page; no provider credential is relayed.
// This site reserves nothing, and never shows a reservation as made.
import { allergenLabel, COURSE_LABELS } from "./finder.js";
import { canCheckReservations, hasAgent } from "./shop-data.js";

const STORAGE_KEY = "reservation-finder-shop-v1";
const FRAME_WAIT_MS = 8000;

/** The shop id a link asked for: null when none, undefined when it is not a usable id. */
export function requestedShop(search) {
  const params = new URLSearchParams(search);
  if (!params.has("shop")) return null;
  const id = params.get("shop");
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ? id : undefined;
}

/** The search conditions as one line the visitor can check before they go to a shop. */
export function conditionsLine(conditions) {
  if (!conditions) return "Choose a date, time, and party size on the shop’s page.";
  const c = conditions;
  return `Shared with the shop: ${c.date} ${c.time} / Guests: ${c.partySize} / ${COURSE_LABELS[c.course]}`
    + (c.budgetPerPerson ? ` / ¥${c.budgetPerPerson.toLocaleString("en-US")} per person` : "")
    + (c.avoid.length ? ` / Foods to avoid: ${c.avoid.map(allergenLabel).join(", ")}` : "")
    + " (Name, contact details, and notes stay here.)";
}

/**
 * Whether a message really comes from the shop this site is showing: from the frame's own
 * window, at the shop's origin. Anything else is ignored, whatever it claims.
 */
export function fromShopFrame(event, frameWindow, shop) {
  return !!shop && !!frameWindow && event.source === frameWindow && event.origin === new URL(shop.pageUrl).origin
    && !!event.data && typeof event.data.type === "string";
}

export class ShopFrame {
  constructor({ shops, relay, getPage, modelName, storage = null }) {
    Object.assign(this, { shops, relay, getPage, modelName, storage });
    this.shop = null;
    this.target = "shop";
    this.conditions = null;
    this.frameTimer = null;
    this.voiceSequence = 0;
    this.voicePending = null;
    if (relay) relay.onChange = () => {};
  }
  element(id) { return document.getElementById(id); }
  find(id) { return this.shops.find(shop => shop.id === id) || null; }
  showError(reason) {
    this.element("shop-error-text").textContent = reason;
    this.element("shop-error").hidden = false;
  }
  remember() {
    try {
      if (this.shop) this.storage?.setItem(STORAGE_KEY, JSON.stringify({ id: this.shop.id, target: this.target }));
      else this.storage?.removeItem(STORAGE_KEY);
    } catch { /* Optional storage. */ }
    const url = new URL(location.href);
    if (this.shop) { url.searchParams.set("shop", this.shop.id); url.searchParams.set("view", this.target); }
    else { url.searchParams.delete("shop"); url.searchParams.delete("view"); }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  remembered() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      try { const value = JSON.parse(raw); return typeof value.id === "string" ? value : null; }
      catch { return { id: raw, target: "shop" }; }
    } catch { return null; }
  }
  post(message) {
    if (this.shop) this.element("shop-page-frame").contentWindow?.postMessage(message, new URL(this.shop.pageUrl).origin);
  }
  setVoicePanelOpen(open) {
    if (this.voicePanelOpen === open) return;
    this.voicePanelOpen = open;
    this.post({ type: "gemihub:voice-panel", shop: this.shop?.id, open });
  }
  open(id, { target = "shop", courseId } = {}) {
    const shop = typeof id === "string" ? this.find(id) : null;
    if (!shop || !["shop", "reserve"].includes(target)) {
      const reason = "That shop is not listed. Choose one from the directory.";
      this.showError(reason);
      return { ok: false, reason };
    }
    if (target === "reserve" && !canCheckReservations(shop)) return { ok: false, reason: "Visit the shop’s website for booking information." };
    if (!hasAgent(shop)) return { ok: false, reason: "Use the link to open this shop’s website." };
    if (!this.shop) { this.previousScroll = scrollY; this.previousFocus = document.activeElement; }
    this.endRelay();
    this.shop = shop;
    this.target = target;
    this.element("shop-error").hidden = true;
    const framed = this.getPage().framedShopUrl(shop.id, target, courseId);
    this.conditions = framed.conditions;
    const previous = this.element("shop-page-frame");
    const frame = previous.cloneNode(false);
    frame.removeAttribute("src");
    previous.replaceWith(frame);
    frame.title = `${shop.name} — ${target === "reserve" ? "Booking" : "Shop page"}`;
    frame.src = framed.url;
    this.element("shop-page-newtab").href = framed.url;
    const status = this.element("shop-page-status");
    status.dataset.state = "loading";
    status.textContent = `Opening ${shop.name}…`;
    clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(() => {
      if (status.dataset.state !== "loading") return;
      status.dataset.state = "failed";
      status.textContent = "The shop page could not be loaded here. Try opening it in a new tab.";
    }, FRAME_WAIT_MS);
    this.remember();
    this.render();
    this.element("shop-close").focus();
    return { ok: true, shop: shop.name, target, conditionsPassed: !!framed.conditions, note: "The shop page is open. Check its products, services, and booking details there." };
  }
  close() {
    if (!this.shop) return;
    this.endRelay();
    clearTimeout(this.frameTimer);
    this.shop = null;
    this.conditions = null;
    const previous = this.element("shop-page-frame");
    const frame = previous.cloneNode(false);
    frame.removeAttribute("src");
    previous.replaceWith(frame);
    this.remember();
    this.render();
    this.previousFocus?.focus({ preventScroll: true });
    scrollTo(0, this.previousScroll || 0);
  }
  endRelay({ keepVoice = false } = {}) {
    if (!keepVoice && this.voicePending) { this.voicePending.reject(new Error("お店の音声会話を終了しました。")); this.voicePending = null; }
    const closed = this.relay?.close();
    if (closed) this.post({ type: "gemihub:relay-closed", session: closed.id, reason: "The shop page was closed." });
  }
  onMessage(event) {
    const frame = this.element("shop-page-frame");
    if (!fromShopFrame(event, frame.contentWindow, this.shop)) return;
    const data = event.data;
    if (data.shop === this.shop.id) {
      if (data.type === "gemihub:voice-capabilities") { this.post({ type: "gemihub:voice-capabilities", shop: this.shop.id, available: typeof this.onVoiceOpen === "function", panelOpen: this.voicePanelOpen === true }); return; }
      if (data.type === "gemihub:voice-open") { if (navigator.userActivation?.isActive) this.onVoiceOpen?.(); return; }
    }
    const pending = this.voicePending;
    if (pending && data.channel === pending.channel && data.shop === this.shop.id) {
      if (data.type === "gemihub:voice-ready") { pending.ready = true; this.post({ type: "gemihub:voice-question", channel: pending.channel, id: pending.id, question: pending.question }); return; }
      if (data.type === "gemihub:voice-review" && data.id === pending.id && typeof data.open === "boolean") { this.onVoiceReview?.(data.open); return; }
      if (data.type === "gemihub:voice-answer" && data.id === pending.id && typeof data.answer === "string" && data.answer.length <= 20000) { pending.resolve(data.answer); return; }
      if (data.type === "gemihub:voice-error" && data.id === pending.id) { pending.reject(new Error("この店の音声会話に接続できませんでした。店舗ページを確認してください。")); return; }
    }
    if (!hasAgent(this.shop) && data.type !== "gemihub:reserve-ready") return;
    if (data.type === "gemihub:reserve-ready" && data.version === 1 && data.shop === this.shop.id) {
      clearTimeout(this.frameTimer);
      this.element("shop-page-status").dataset.state = "ready";
      this.element("shop-page-status").textContent = "";

    }
  }
  render() {
    const open = !!this.shop;
    document.body.dataset.shopView = open ? "open" : "closed";
    this.element("shop-view-header").hidden = !open;
    this.element("shop-page-panel").hidden = !open;
    this.element("assistant-layout").dataset.page = open ? "open" : "closed";
    this.element("shop-name").textContent = this.shop?.name || "";
    this.onChange?.();
  }
  askVoice(question, signal) {
    if (!this.shop || !hasAgent(this.shop) || this.voicePending || typeof question !== "string" || question.length > 4000 || signal?.aborted) return Promise.reject(new Error("お店の会話を準備できませんでした。"));
    return new Promise((resolve, reject) => {
      const channel = `voice-${Date.now()}-${++this.voiceSequence}`, id = channel;
      const cleanup = () => { clearInterval(retry); clearTimeout(timeout); signal?.removeEventListener("abort", abort); if (this.voicePending?.channel === channel) { this.voicePending = null; this.onVoiceReview?.(false); } };
      const abort = () => { this.post({ type: "gemihub:voice-cancel", channel, id }); cleanup(); reject(new Error("音声の質問を中止しました。")); };
      const pending = { channel, id, question, ready: false, resolve: answer => { cleanup(); resolve(answer); }, reject: error => { cleanup(); reject(error); } };
      this.voicePending = pending;
      const connect = () => { if (!pending.ready) this.post({ type: "gemihub:voice-connect", channel, shop: this.shop?.id }); };
      const retry = setInterval(connect, 500);
      const timeout = setTimeout(() => { this.post({ type: "gemihub:voice-cancel", channel, id }); pending.reject(new Error("お店の返答を確認できませんでした。画面を確認してください。")); }, 120000);
      signal?.addEventListener("abort", abort, { once: true }); connect();
    });
  }
  mount() {
    this.element("shop-close").addEventListener("click", () => this.close());
    window.addEventListener("message", event => this.onMessage(event));
    window.addEventListener("pagehide", () => this.endRelay());
    const requested = requestedShop(location.search);
    const saved = this.remembered();
    if (requested === undefined) {
      this.showError("The shop link is invalid. Choose a shop from the directory.");
      this.remember();
    } else {
      const id = requested || saved?.id;
      const target = new URLSearchParams(location.search).get("view") || saved?.target || "shop";
      if (id && !this.open(id, { target }).ok) this.remember();
    }
    this.render();
  }
}
