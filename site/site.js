// Adapted from the official template for the reservation finder. Runtime unchanged.
// Mounts the assistant inside the existing page. Load it with:
//   <script type="module" src="site.js"></script>
// The page needs the mount markup from assistant-section.html.
import { App } from "./script.js";
import { allergenLabel, COURSE_LABELS } from "./finder.js";
import { ShopInquiries, installInquiryPolicy, reviewShopInquiries } from "./inquiries.js";
import { ShopFrame } from "./shop-frame.js";
import { aiConnection, mountAiConnection, installHybridEngine, readPublishedFacts } from "./ai-connection.js";
import { GuideVoice } from "./voice-chat.js";
import { GUIDE_GREETING, guideGreeting } from "./guide-copy.js";
import { mountDocumentPreview } from "./chat-documents.js";

/**
 * Boots the browser runtime in the page's assistant section.
 *
 * It points the runtime at this folder, so the manifest, network and actions load from
 * the same place as the page. Before each irreversible action, it shows its own
 * confirmation dialog, written for the visitor.
 */
export class AssistantMount {
  /**
   * The first chat message once the visitor has a key: what the assistant can do here.
   */
  /** Keep the frequent send action beside the input; put reset in a quiet header menu. */
  static mountChatControls() {
    const english = document.documentElement.lang === "en";
    const reset = document.getElementById("ns-newchat");
    const input = document.getElementById("ns-input");
    input.placeholder = english ? "Ask about local information, events or shops…" : "街の情報・イベント・お店について相談…";
    input.setAttribute("aria-label", english ? "Message to the AI" : "AIへのメッセージ");
    document.getElementById("ns-send").textContent = english ? "Send" : "送信";
    const menu = document.createElement("details");
    menu.className = "assistant-chat-menu";
    const summary = document.createElement("summary");
    summary.textContent = "⋯";
    summary.setAttribute("aria-label", english ? "Conversation options" : "会話のメニュー");
    reset.textContent = english ? "Start a new conversation" : "会話をやり直す";
    reset.title = english ? "Clear this conversation and start again" : "この会話を消して新しく始めます";
    reset.removeAttribute("style");
    menu.append(summary, reset);
    const toolbar = document.createElement("div");
    toolbar.className = "finder-chat-toolbar";
    toolbar.append(menu);
    document.getElementById("ns-msgs").closest(".ns-chat").prepend(toolbar);
    reset.addEventListener("click", () => { menu.open = false; input.focus(); });
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

  static get GREETING() {
    return GUIDE_GREETING;
  }

  /**
   * The confirmation dialog's words for each irreversible action. Name each button after
   * what it does, so that "Cancel" never has two meanings. With no irreversible action,
   * leave this empty.
   */
  static DIALOGS = {
    open_shop_page: {
      title: "Open the shop with these booking details?",
      sentence: "Share the date, time, party size, course preference, budget, and food restrictions. Your name and contact details stay here. Confirm your reservation on the shop's page.",
      confirm: "Share details and open shop",
      decline: "Stay here",
    },
  };

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      // Load the runtime here, so a missing or broken runtime is reported too.
      const { boot } = await import("./runtime/index.js");
      const connection = await aiConnection();
      const publishedFacts = await readPublishedFacts(new URL("./shop-public-facts.json", siteBase).href) || {};
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
        ...(connection?.setup || {}),
      });
      AssistantMount.engine = booted.engine;
      AssistantMount.mountChatControls();
      mountDocumentPreview(document.getElementById("ns-msgs"));
      AssistantMount.defaultReview = booted.engine.onActionConfirm;
      booted.engine.onActionConfirm = AssistantMount.review;
      App.inquiries = new ShopInquiries(() => App.page, reviewShopInquiries,
        () => [...document.querySelectorAll("#ns-msgs .ns-msg.user")].at(-1)?.textContent || "");
      installInquiryPolicy(booted.engine, App.inquiries);
      const engine = booted.engine;
      installHybridEngine(engine, connection, { getShops: () => App.page.shops.map(shop => {
        const facts = publishedFacts[shop.id];
        return facts?.sourcePageUrl === shop.pageUrl ? { ...shop, hours: facts.hours, products: facts.menu || facts.products } : shop;
      }) });
      const model = () => engine.modelOverride || engine.top.network.config.llm_config.model_name;
      App.shopFrame = new ShopFrame({
        shops: App.page.shops, getPage: () => App.page, modelName: model, storage: AssistantMount.tabStorage(),

      });
      status.textContent = "Ready to chat.";
      AssistantMount.greet();
      App.mountChat();
      mountAiConnection(booted.engine, connection);
      // Last, so a shop named in the address opens once the AI setup is known.
      App.shopFrame.mount();
      App.voice = new GuideVoice({ engine, shopFrame: App.shopFrame, shops: App.page.shops, config: connection?.config });
      return booted.engine;
    } catch (error) {
      // The page must keep working without the assistant.
      status.textContent = "The assistant could not start. You can still browse shops below.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  static tabStorage() {
    try { return window.sessionStorage; } catch { return null; }
  }

  /**
   * Replace the runtime's general first chat message with GREETING. "New chat" keeps the
   * first message, so the greeting stays for the whole visit.
   */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = guideGreeting(document.getElementById("assistant")?.dataset.greeting, document.documentElement.lang);
    }
  }

  /**
   * Ask the visitor to confirm actions before they run. One of this page's actions listed
   * in DIALOGS gets this page's dialog. Anything else, such as a partner site's action,
   * gets the runtime's own dialog.
   *
   * :param items: The actions waiting for confirmation, each with action, origin, effect
   *   and arguments.
   * :return: True when the visitor confirms.
   * :raises Error: The site's reason, when its own check refuses the action, or when a
   *   chat form bundles one of this page's DIALOGS actions with other actions.
   */
  static async review(items) {
    let confirmed = false;
    const pageOrigin = new URL(document.URL).origin;
    // This page's dialog shows one action with its details and runs the site's own check.
    // A chat form that bundles such an action with others would skip both, so nothing
    // runs.
    if (items.length > 1) {
      for (const item of items) {
        if (item.origin === pageOrigin && Object.hasOwn(AssistantMount.DIALOGS, item.action)) {
          throw new Error("Confirm opening the shop separately from other actions.");
        }
      }
    }
    // A partner's action can have the same name as one of this page's. It gets the
    // runtime's dialog, which names the partner's origin, and this page's check never runs.
    const own = items.length === 1 && items[0].origin === pageOrigin;
    if (own && Object.hasOwn(AssistantMount.DIALOGS, items[0].action)) {
      const content = AssistantMount.dialogContent(items[0]);
      if (content.refusal) {
        // A dialog would offer a button that cannot work. The runtime runs nothing
        // and gives the agent this reason as an "Error from tool" message.
        throw new Error(content.refusal);
      }
      confirmed = await new Promise(AssistantMount.openDialog.bind(null, content));
    } else {
      confirmed = await AssistantMount.defaultReview(items);
    }
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /**
   * Work out what the dialog says for one action: its words from DIALOGS, the readable
   * details and the exact call. This is plain data, so tests can check it.
   *
   * :param item: An action waiting for confirmation, with action, origin, effect and
   *   arguments.
   * :return: The title, sentence, button labels, details, exact call text and the
   *   site's refusal, if any.
   */
  static dialogContent(item) {
    let details = {};
    try {
      details = AssistantMount.reviewDetails(item.action, item.arguments) || {};
    } catch (error) {
      // Refuse when the page cannot validate the proposal.
      details = { refusal: "Could not verify the booking details. Please try again." };
    }
    return {
      ...AssistantMount.DIALOGS[item.action],
      details: details,
      refusal: details.refusal,
      exact: `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`,
    };
  }

  /**
   * Give the readable details of one irreversible action, such as items, total, name,
   * email and what undoing it would cost, from the page's own read-only operations, so
   * no rule is copied here. When the operation's own check refuses the call, return
   * {refusal: reason}, and review() opens no dialog.
   *
   * :param action: The action name.
   * :param args: The action's arguments.
   * :return: Details by label, {refusal: reason}, or {} when the action has none.
   */
  static reviewDetails(action, args) {
    if (action === "open_shop_page") {
      const check = App.page.checkOpenShop(args);
      if (!check.ok) return { refusal: check.reason };
      const c = check.conditions;
      const candidate = App.page.candidates.find(item => item.shopId === args.shopId);
      return {
        "Shop": check.shop.name,
        "Destination": new URL(check.url).host,
        "Date and time": `${c.date} ${c.time} (Japan time)`,
        "Guests": c.partySize,
        "Booking type": COURSE_LABELS[c.course],
        ...(args.courseId ? { "Course": `${candidate.courseName || args.courseId} (${args.courseId})` } : {}),
        "Budget": c.budgetPerPerson === undefined ? "Any" : `¥${c.budgetPerPerson.toLocaleString("en-US")} per person`,
        "Foods to avoid": c.avoid.map(allergenLabel).join(", ") || "None",
        "Private information kept here": "Name, email, phone number, notes, and AI settings",
      };
    }
    return {};
  }

  /**
   * Open the confirmation dialog: a question, a plain sentence, the readable details,
   * the exact call under "Technical details", and two buttons.
   *
   * :param content: What the dialog says, from dialogContent().
   * :param resolve: Receives true when the visitor confirms, and false otherwise.
   */
  static openDialog(content, resolve) {
    const dialog = document.createElement("dialog");
    dialog.className = "assistant-review";
    dialog.setAttribute("aria-labelledby", "assistant-review-title");
    const heading = document.createElement("h2");
    heading.id = "assistant-review-title";
    heading.textContent = content.title;
    // Start on the heading, which Enter cannot activate, so a stray Enter confirms nothing.
    heading.tabIndex = -1;
    heading.autofocus = true;
    const sentence = document.createElement("p");
    sentence.textContent = content.sentence;
    dialog.append(heading, sentence);
    const exact = document.createElement("details");
    const exactLabel = document.createElement("summary");
    exactLabel.textContent = "Action details";
    const exactText = document.createElement("pre");
    exactText.textContent = content.exact;
    exact.append(exactLabel, exactText);
    const entries = Object.entries(content.details);
    if (entries.length) {
      const list = document.createElement("dl");
      for (const [label, value] of entries) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = String(value);
        list.append(term, description);
      }
      dialog.append(list);
    } else {
      // Without readable details, open the exact call, so the visitor still sees it.
      exact.open = true;
    }
    const confirmButton = document.createElement("button");
    confirmButton.textContent = content.confirm;
    confirmButton.addEventListener("click", dialog.close.bind(dialog, "confirm"));
    const declineButton = document.createElement("button");
    declineButton.className = "assistant-decline";
    declineButton.textContent = content.decline;
    declineButton.addEventListener("click", dialog.close.bind(dialog, "decline"));
    // Escape also closes the dialog, without "confirm".
    dialog.addEventListener("close", AssistantMount.finishDialog.bind(null, dialog, resolve));
    dialog.append(exact, confirmButton, declineButton);
    document.body.append(dialog);
    dialog.showModal();
  }

  /**
   * Remove the closed dialog and report the visitor's choice.
   *
   * :param dialog: The dialog that just closed.
   * :param resolve: Receives true when the visitor pressed the confirm button.
   */
  static finishDialog(dialog, resolve) {
    dialog.remove();
    resolve(dialog.returnValue === "confirm");
  }

  /**
   * Put focus back in the chat input when a dialog or the consent card left it on the
   * page body. A chat form disables its controls when it is sent, so focus can fall to
   * the body, and the next Tab would start at the top of the page.
   */
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
