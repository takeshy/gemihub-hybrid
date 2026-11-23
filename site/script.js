import "./dev-site.js";
import { mountShopDirectory } from "./shop-directory.js";
import { FinderPage } from "./finder.js";
import { shops } from "./shop-registry.js";
import { canCheckReservations, hasAgent, reservationPageUrl, shopPageUrl } from "./shop-data.js";

const node = (tag, content, className) => {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = String(content);
  if (className) element.className = className;
  return element;
};

export class App {
  static inquiries = null;
  static shopFrame = null;
  static page = new FinderPage(shops, {
    // Leave the tool receipt time to reach the chat before leaving this document.
    navigate: url => setTimeout(() => location.assign(url), 100),
    onChange: kind => { if (typeof document !== "undefined") App.render(kind); },
  });
  static saveDraft() {
    // The official AI settings reload the page. Keep conditions in this tab only;
    // comparison results and any provider credentials are never stored here.
    try { sessionStorage.setItem("reservation-finder-draft-v1", JSON.stringify(App.page.conditions)); } catch { /* Storage may be disabled. */ }
  }

  static restoreDraft() {
    try {
      const draft = JSON.parse(sessionStorage.getItem("reservation-finder-draft-v1"));
      if (!draft || Array.isArray(draft) || typeof draft !== "object") return;
      const known = ["date", "time", "partySize", "course", "budgetPerPerson", "avoid", "note"];
      if (Object.keys(draft).some(key => !known.includes(key))) return;
      if (!["date", "time", "course", "note"].every(key => typeof draft[key] === "string")) return;
      if (draft.date.length > 10 || draft.time.length > 5 || draft.note.length > 500 || !["none", "wanted", "any"].includes(draft.course)) return;
      if (draft.partySize !== null && (typeof draft.partySize !== "number" || !Number.isFinite(draft.partySize))) return;
      if (draft.budgetPerPerson !== undefined && (typeof draft.budgetPerPerson !== "number" || !Number.isFinite(draft.budgetPerPerson))) return;
      if (!Array.isArray(draft.avoid) || draft.avoid.length > 13 || !draft.avoid.every(word => typeof word === "string" && word.length <= 20)) return;
      App.page.editConditions(draft);
    } catch { /* Invalid or unavailable tab storage must not prevent startup. */ }
  }

  static render(kind) {
    if (kind === "conditions" || kind === "draft") {
      App.saveDraft();
      App.inquiries?.invalidate();
    }
    const state = App.page.getState();
    App.renderCandidates(state);
    App.renderIntroductions(state);
  }

  static introductionCard(shop) {
    const card = node("article", undefined, "candidate-card shop-introduction");
    card.dataset.shopId = shop.id;
    card.append(node("span", `${shop.area} / ${shop.cuisine}`, "eyebrow"), node("h3", shop.name));
    if (shop.description) card.append(node("p", shop.description));
    card.append(node("p", `${hasAgent(shop) ? "Ask the shop’s assistant" : "Visit the shop’s website for details"}${canCheckReservations(shop) ? " · Reservations available" : ""}`, "muted"));
    const actions = node("div", undefined, "candidate-actions");
    if (hasAgent(shop)) {
      const open = node("button", "Open shop", "candidate-chat");
      open.type = "button";
      open.addEventListener("click", () => App.shopFrame?.open(shop.id, { target: "shop" }));
      actions.append(open);
    } else {
      const link = node("a", "Open shop website ↗", "candidate-chat");
      link.href = shopPageUrl(shop); link.target = "_blank"; link.rel = "noopener noreferrer";
      actions.append(link);
    }
    if (canCheckReservations(shop)) {
      const reserve = node("button", "Open booking page", "candidate-button");
      reserve.type = "button";
      reserve.addEventListener("click", () => App.shopFrame?.open(shop.id, { target: "reserve" }));
      actions.append(reserve);
    }
    card.append(actions);
    return card;
  }

  static renderIntroductions(state) {
    // The runtime appends its answer before returning the input bar to idle.
    if (!state.introductions?.length || document.querySelector(".ns-inputbar")?.dataset.turnActive === "true") return;
    const messages = document.getElementById("ns-msgs");
    if (!messages || messages.querySelector(`.finder-introductions[data-introduction="${state.introductionVersion}"]`)) return;
    const result = node("div", undefined, "ns-msg bot finder-introductions");
    result.dataset.introduction = String(state.introductionVersion);
    result.setAttribute("role", "group"); result.setAttribute("aria-label", "Suggested shops");
    const list = node("div", undefined, "finder-candidate-list");
    for (const id of state.introductions) list.append(App.introductionCard(App.page.shops.find(shop => shop.id === id)));
    result.append(list); messages.append(result); messages.scrollTop = messages.scrollHeight;
  }

  static renderCandidates(state) {
    const messages = document.getElementById("ns-msgs");
    if (!messages) return;
    let current = null;
    for (const message of messages.querySelectorAll(".finder-results")) {
      if (Number(message.dataset.version) === state.version && state.candidates.length) {
        current = message;
      } else {
        message.dataset.current = "false";
        message.querySelector(".finder-results-status").textContent = "The search details changed. Check availability again.";
        for (const button of message.querySelectorAll("button")) button.disabled = true;
      }
    }
    if (!state.candidates.length) return;
    // The runtime appends its final answer before returning the input bar to idle.
    if (document.querySelector(".ns-inputbar")?.dataset.turnActive === "true") return;
    if (!current) {
      current = node("div", undefined, "ns-msg bot finder-results");
      current.dataset.version = String(state.version);
      current.setAttribute("role", "group");
      current.setAttribute("aria-label", "Replies from shops");
      messages.append(current);
    }
    current.dataset.current = "true";
    const heading = node("p", `${state.conditions.date} ${state.conditions.time} / Guests: ${state.conditions.partySize} · Shop replies: ${state.candidates.length}`, "finder-results-heading");
    const list = node("div", undefined, "finder-candidate-list");
    const status = node("p", "", "finder-results-status");
    status.setAttribute("role", "status");
    current.replaceChildren(heading, list, status);
    const labels = { available: "Available", full: "Fully booked", unknown: "Unconfirmed", declined: "Unavailable" };
    for (const candidate of state.candidates) {
      const shop = App.page.shops.find(item => item.id === candidate.shopId);
      const card = node("article", undefined, "candidate-card");
      card.append(node("span", labels[candidate.status], `status-badge status-${candidate.status}`), node("h3", shop.name), node("p", candidate.summary));
      if (candidate.status === "available") {
        const details = node("dl");
        const line = (label, value) => { if (value !== undefined) details.append(node("dt", label), node("dd", value)); };
        line("Seats left", candidate.remaining);
        line("Duration", candidate.durationMinutes === undefined ? undefined : `${candidate.durationMinutes} min`);
        line("Table only", candidate.seatOnly === undefined ? undefined : candidate.seatOnly ? "Available" : "Course required");
        if (state.conditions.course !== "none") { line("Course", candidate.courseName); line("Estimated price", candidate.priceText); }
        card.append(details);
        if (candidate.avoidResult) card.append(node("p", `Ingredient check: ${candidate.avoidResult}`, "allergen-note"));
      }
      const chat = node("button", "Open shop", "candidate-chat");
      chat.type = "button";
      chat.addEventListener("click", () => {
        const result = App.shopFrame?.open(shop.id, { target: "shop" });
        if (!result) status.textContent = "Please wait for the assistant to finish loading.";
        else if (!result.ok) status.textContent = result.reason;
      });
      const actions = node("div", undefined, "candidate-actions");
      actions.append(chat);
      card.append(actions);
      if (!state.valid || !canCheckReservations(shop) || candidate.status !== "available") { list.append(card); continue; }
      const button = node("button", "Open booking page", "candidate-button");
      button.type = "button";
      button.addEventListener("click", () => {
        const result = App.shopFrame?.open(shop.id, {
          target: "reserve",
          ...(state.conditions.course !== "none" && candidate.courseId ? { courseId: candidate.courseId } : {}),
        });
        if (!result?.ok) status.textContent = result?.reason || "The booking page is not ready.";
      });
      actions.append(button);
      list.append(card);
    }
    if (messages.lastElementChild !== current) messages.append(current);
    messages.scrollTop = messages.scrollHeight;
  }

  static mountChat() {
    document.getElementById("ns-newchat").addEventListener("click", () => {
      App.page.clearCandidates();
      App.inquiries?.reset();
    });
    const bar = document.querySelector(".ns-inputbar");
    if (bar && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => {
        if (bar.dataset.turnActive === "false") App.render("turn");
      }).observe(bar, { attributes: true, attributeFilter: ["data-turn-active"] });
    }
    App.render("init");
  }

  static start() {
    App.restoreDraft();
    App.renderDirectory();
    App.render("init");
  }

  static addSampleShop(shop) {
    if (App.page.shops.some(item => item.id === shop.id)) return;
    App.page.shops.push(shop);
    App.renderDirectory();
  }

  static renderDirectory() {
    const shops = App.page.shops;
    document.getElementById("shop-count").textContent = String(shops.length);
    const list = document.getElementById("shop-list");
    list.replaceChildren();
    const cards = new Map();
    for (const shop of shops) {
      const card = node("article", undefined, "shop-card");
      cards.set(shop.id, card);
      card.append(node("span", `${shop.area} / ${shop.cuisine}`, "eyebrow"), node("h3", shop.name));
      if (shop.description) card.append(node("p", shop.description));
      const chat = node("button", "Open shop", "candidate-chat");
      chat.type = "button";
      chat.addEventListener("click", () => {
        if (!App.shopFrame) return;
        App.shopFrame.open(shop.id, { target: "shop" });
      });
      if (hasAgent(shop)) card.append(chat);
      else {
        const link = node("a", "Open shop website ↗", "candidate-chat");
        link.href = shopPageUrl(shop); link.target = "_blank"; link.rel = "noopener noreferrer";
        card.append(link);
      }
      const details = node("details"); details.append(node("summary", "Public links"));
      for (const [label, url] of [["Shop website", shopPageUrl(shop)], ...(canCheckReservations(shop) ? [["Booking page", reservationPageUrl(shop)]] : []), ...(hasAgent(shop) ? [["Agent", shop.networkUrl]] : [])]) {
        const a = node("a", `${label}: ${url}`); a.href = url; a.rel = "noreferrer"; details.append(a);
      }
      card.append(details); list.append(card);
    }
    mountShopDirectory({ shops, cards });
  }
}

if (typeof window !== "undefined") App.start();
