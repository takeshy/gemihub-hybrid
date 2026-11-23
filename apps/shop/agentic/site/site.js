// Mounts the assistant inside the reservation page. Adapted from the agentify-website
// skill's templates/site.js: the dialog's details come from the page's own read-only
// check, which asks the server, so reviewDetails is awaited.
import { App } from "./reserve-page.js";
import { openReviewDialog } from "./review-dialog.js";
import { aiConnection, mountAiConnection, installHybridEngine, readPublishedFacts } from "./ai-connection.js";
import { mountShopVoiceBridge } from "./voice-bridge.js";

const WORDS = {
  ja: {
    greeting: "日時と人数を教えてください。席だけの予約でも、コースの予約でも承ります。避けたい食材があれば、コースや料理の材料もお調べします。予約の確定前に、内容を確認する画面が出ます。",
    greetingCarried: "前のサイトから条件を引き継ぎました。「反映」を押すと、空席を確かめて予約を進めます。",
    needsKey: "「AIの設定」で、ご自身のAIプロバイダーのキーを設定してください。",
    connected: "アシスタントがこのページにつながりました。",
    failed: "アシスタントを読み込めませんでした。",
    relay: {
      preparing: "アシスタントを準備しています…",
      waiting: "お店さがしサイトで、あなたのAIをこのお店のチャットに使うことを許可してください。",
      open: "お店さがしサイトで設定したあなたのAIにつながりました。AIのキーはこのお店には渡されていません。",
      denied: "AIの利用が許可されなかったため、チャットは始めていません。",
      closed: "AIの中継が止まりました。チャットを続けるには、お店さがしサイトでこのお店を開き直してください。",
      unsupported: "このブラウザの設定では、ここでAIのチャットを使えません。お店さがしサイトでページを再読み込みすると、もう一度試せます。",
    },
    bundled: "何も実行していません。「{0}」は単独で確認が必要です。アシスタントにその操作だけを頼んでください。",
  },
  en: {
    greeting: "Tell me the date, time and party size. I can reserve seats only or a course, and check what each course and dish contains if there is a food to avoid. You confirm the details before anything is reserved.",
    greetingCarried: "The conditions from the previous site are here. Press \"Apply\" and I will check the seats and go on.",
    needsKey: "Add your own AI provider key in AI settings.",
    connected: "Assistant connected to this page.",
    failed: "The assistant could not load.",
    relay: {
      preparing: "Preparing the assistant…",
      waiting: "On the restaurant finder site, allow this restaurant's chat to use your AI.",
      open: "Connected to the AI you set up on the restaurant finder site. Your AI key has not been given to this restaurant.",
      denied: "Using your AI was not allowed, so the chat has not started.",
      closed: "The AI relay has stopped. To go on chatting, open this restaurant again on the restaurant finder site.",
      unsupported: "With this browser's settings the AI chat cannot be used here. Reload the page on the restaurant finder site to try again.",
    },
    bundled: "Nothing ran. \"{0}\" needs its own confirmation, so ask the assistant to do that on its own.",
  },
};

/**
 * Boots the browser runtime in the page's assistant section and shows this page's own
 * confirmation dialog before a reservation is made.
 */
export class AssistantMount {
  /** The irreversible actions that get this page's dialog. */
  static DIALOG_ACTIONS = ["place_reservation"];

  static mountCarriedConditions() {
    if (!App.page?.getRequest() || document.getElementById("reserve-carried")) return;
    const english = document.documentElement.lang === "en";
    const card = document.createElement("div");
    card.id = "reserve-carried";
    card.className = "ns-msg bot carried-conditions";
    const text = document.createElement("p");
    text.id = "reserve-carried-text";
    text.textContent = `${english ? "Reservation conditions from the finder" : "親からの予約条件"}: ${App.page.requestText()}`;
    const apply = document.createElement("button");
    apply.id = "reserve-continue";
    apply.type = "button";
    apply.textContent = english ? "Apply" : "反映";
    apply.addEventListener("click", () => App.page.continueInChat());
    card.append(text, apply);
    document.getElementById("ns-msgs").append(card);
    const bar = document.querySelector(".ns-inputbar");
    const observer = new MutationObserver(() => {
      if (!card.isConnected) { observer.disconnect(); return; }
      apply.disabled = bar.dataset.turnActive === "true";
    });
    observer.observe(bar, { attributes: true, attributeFilter: ["data-turn-active"] });
  }

  /** Keep the frequent send action beside the input; put reset in a quiet header menu. */
  static mountChatControls() {
    const english = document.documentElement.lang === "en";
    const reset = document.getElementById("ns-newchat");
    const input = document.getElementById("ns-input");
    const idlePlaceholder = document.documentElement.dataset.agentKind === "shop"
      ? english ? "Ask about hours or products…" : "営業時間や扱っている品について相談…"
      : english ? "Ask about seats or courses…" : "空席やコースについて相談…";
    const bar = document.querySelector(".ns-inputbar");
    const send = document.getElementById("ns-send");
    const syncControls = () => {
      const active = bar.dataset.turnActive === "true";
      input.placeholder = active
      ? english ? "Add guidance while the assistant works…" : "返答中のAIに追加で伝える…"
      : idlePlaceholder;
      send.textContent = active ? english ? "Update" : "追加" : english ? "Send" : "送信";
    };
    // The runtime restores its original placeholder after every turn; keep this page's wording.
    const observer = new MutationObserver(syncControls);
    observer.observe(bar, { attributes: true, attributeFilter: ["data-turn-active"] });
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
    syncControls();
    input.setAttribute("aria-label", english ? "Message to the AI" : "AIへのメッセージ");
    const menu = document.createElement("details");
    menu.className = "assistant-chat-menu";
    const summary = document.createElement("summary");
    summary.textContent = "⋯";
    summary.setAttribute("aria-label", english ? "Conversation options" : "会話のメニュー");
    reset.textContent = english ? "Start a new conversation" : "会話をやり直す";
    reset.title = english ? "Clear this conversation and start again" : "この会話を消して新しく始めます";
    reset.removeAttribute("style");
    menu.append(summary, reset);
    document.querySelector(".assistant-sidebar-header").insertBefore(menu, document.getElementById("assistant-close"));
    reset.addEventListener("click", () => { menu.open = false; AssistantMount.mountCarriedConditions(); input.focus(); });
    document.addEventListener("click", event => { if (!menu.contains(event.target)) menu.open = false; });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape" && menu.open) {
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        summary.focus();
      }
    });
  }

  /** Open a chat screen while keeping the original page intact for returning. */
  static mountPanel() {
    const panel = document.getElementById("assistant");
    const toggle = document.getElementById("assistant-toggle");
    const syncBackground = () => {
      for (const element of document.querySelectorAll(".reserve-shell, #root, .restaurant-site-header, body > main")) element.inert = !panel.hidden;
    };
    const storageKey = `restaurant-assistant-open:${document.documentElement.dataset.slug}`;
    const show = (open) => {
      panel.hidden = !open;
      document.body.classList.toggle("assistant-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      syncBackground();
      try {
        if (open) sessionStorage.setItem(storageKey, "1");
        else sessionStorage.removeItem(storageKey);
      } catch { /* The drawer also works with storage disabled. */ }
      if (open) {
        void AssistantMount.startAssistant();
        AssistantMount.setup?.openIfNeeded();
        if (!document.querySelector("dialog[open]")) {
          (document.getElementById("ns-input") || document.getElementById("assistant-close")).focus();
        }
      } else toggle.focus();
    };
    toggle.addEventListener("click", () => show(panel.hidden));
    toggle.disabled = false;
    document.getElementById("assistant-close").addEventListener("click", () => show(false));
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !event.defaultPrevented && !panel.hidden && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        show(false);
      }
    });
    if (document.querySelector(".restaurant-reservation-page") || new URL(location.href).searchParams.get("chat") === "reservation") {
      toggle.textContent = document.documentElement.lang === "en" ? "Reserve with AI" : "AIで予約する";
    }
    // Followed links always show the shop first. Only a reload (for example,
    // after saving AI settings) restores a chat the visitor already opened.
    const reloading = performance.getEntriesByType("navigation")[0]?.type === "reload";
    try { if (reloading && !App.embedded() && sessionStorage.getItem(storageKey) === "1") show(true); } catch { /* No saved state. */ }
  }

  static words() {
    const english = document.documentElement.lang === "en";
    const words = WORDS[english ? "en" : "ja"];
    return document.documentElement.dataset.agentKind === "shop" ? { ...words,
      greeting: english ? "Ask me about opening hours, closed days, directions or the products the shop carries." : "営業時間やお休み、お店への行き方、扱っている品についてご相談ください。",
      relay: english ? { ...words.relay,
        waiting: "On the shop finder site, allow this shop's chat to use your AI.",
        open: "Connected to the AI you set up on the shop finder site. Your AI key has not been given to this shop.",
        closed: "The AI relay has stopped. To go on chatting, open this shop again on the shop finder site.",
        unsupported: "With this browser's settings the AI chat cannot be used here. Reload the page on the shop finder site to try again.",
      } : words.relay,
    } : words;
  }

  /** The dialog's words for one action, from the page so its own button says the same. */
  static dialogWords(action) {
    return action === "place_reservation" && App.page ? App.page.dialogWords() : null;
  }

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    if (!App.page && document.documentElement.dataset.agentKind !== "shop") return null;
    AssistantMount.mountPanel();
    if (App.embedded()) mountShopVoiceBridge(() => AssistantMount.startAssistant(), App.page?.slug || document.documentElement.dataset.slug);
    if (!App.embedded()) return AssistantMount.startAssistant();
  }

  static startAssistant() {
    if (AssistantMount.engine) return Promise.resolve(AssistantMount.engine);
    if (!AssistantMount.starting) {
      AssistantMount.starting = AssistantMount.bootAssistant().finally(() => { AssistantMount.starting = null; });
    }
    return AssistantMount.starting;
  }

  static async bootAssistant() {
    const status = document.querySelector("#assistant-status");
    const words = AssistantMount.words();
    const siteBase = new URL("./", import.meta.url).href;
    try {
      const { boot } = await import("./runtime/index.js");
      const connection = await aiConnection();
      const facts = await readPublishedFacts(new URL("./facts.json", siteBase).href);
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
        ...connection.setup,
      });
      AssistantMount.engine = booted.engine;
      installHybridEngine(booted.engine, connection, { scope: "shop", getFacts: () => facts });
      AssistantMount.mountChatControls();
      AssistantMount.defaultReview = booted.engine.onActionConfirm;
      booted.engine.onActionConfirm = AssistantMount.review;
      AssistantMount.defaultConsent = booted.engine.onConsent;
      booted.engine.onConsent = AssistantMount.consent;
      AssistantMount.setup = mountAiConnection(booted.engine, connection);
      if (App.embedded()) {
        const { mountEmbeddedShopVoice } = await import("./shop-voice.js");
        mountEmbeddedShopVoice();
      } else if (connection.config.voice) {
        const { mountShopVoice } = await import("./shop-voice.js");
        AssistantMount.voice = mountShopVoice(booted.engine, connection.config);
      }
      status.textContent = words.connected;
      AssistantMount.greet();
      AssistantMount.mountCarriedConditions();
      return booted.engine;
    } catch (error) {
      status.textContent = words.failed;
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /** Replace the runtime's general first chat message with this page's greeting. */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      const words = AssistantMount.words();
      first.textContent = App.page?.getRequest() ? words.greetingCarried : words.greeting;
    }
  }

  /**
   * Ask the visitor to confirm actions before they run. This page's reservation gets
   * this page's dialog; anything else gets the runtime's own dialog.
   *
   * :param items: The actions waiting for confirmation.
   * :return: True when the visitor confirms.
   * :raises Error: The site's reason, when its own check refuses the action, or when a
   *   chat form bundles the reservation with other actions.
   */
  static async review(items) {
    let confirmed = false;
    const pageOrigin = new URL(document.URL).origin;
    const ownDialog = (item) => item.origin === pageOrigin && AssistantMount.DIALOG_ACTIONS.includes(item.action);
    if (items.length > 1) {
      for (const item of items) {
        if (ownDialog(item)) {
          throw new Error(AssistantMount.words().bundled.replace("{0}", AssistantMount.dialogWords(item.action).confirm));
        }
      }
    }
    if (items.length === 1 && ownDialog(items[0])) {
      const content = await AssistantMount.dialogContent(items[0]);
      if (content.refusal) {
        // No dialog opens: the runtime runs nothing and gives the agent this reason.
        throw new Error(content.refusal);
      }
      confirmed = await openReviewDialog(document, content);
    } else {
      confirmed = await AssistantMount.defaultReview(items);
    }
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /** Ask, with the runtime's consent card, whether to contact another site. */
  static async consent(info) {
    const answer = AssistantMount.defaultConsent(info);
    AssistantMount.focusConsentCard();
    const decision = await answer;
    AssistantMount.keepFocusInChat();
    return decision;
  }

  static focusConsentCard() {
    const cards = document.querySelectorAll("#ns-msgs .ns-consent");
    const card = cards[cards.length - 1];
    const title = card ? card.querySelector(".ns-consent-title") : null;
    if (!title) {
      return;
    }
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", title.textContent);
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("#agent-app")) {
      return;
    }
    title.tabIndex = -1;
    title.focus();
  }

  /**
   * What the dialog says for one action: its words, the readable details from the page's
   * own check, and the exact call. Plain data, so tests can check it.
   */
  static async dialogContent(item) {
    let details = {};
    try {
      details = await AssistantMount.reviewDetails(item.action, item.arguments) || {};
    } catch (error) {
      // The dialog then opens the exact call, and the visitor decides.
      console.error("Could not add details to the confirmation dialog", error);
    }
    const { refusal, ...shown } = details;
    return {
      ...AssistantMount.dialogWords(item.action),
      details: refusal ? {} : shown,
      refusal: refusal,
      exact: `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`,
    };
  }

  /** The readable details of one irreversible action, or {refusal: reason}. */
  static async reviewDetails(action, args) {
    if (action === "place_reservation") {
      return App.page.reviewDetails(args);
    }
    return {};
  }

  static keepFocusInChat() {
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector("#ns-input")?.focus();
    }
  }
}

// Boot only in a browser. Node tests import this file to check the dialog's words.
if (typeof window !== "undefined") {
  await AssistantMount.start();
}
