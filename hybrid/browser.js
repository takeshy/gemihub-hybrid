import { InferenceSource } from "firebase/ai";
import { HybridInference } from "./firebase-client.js";
import {
  DECISION_SCHEMA,
  BOOKING_PREFLIGHT_SCHEMA,
  validateDecision,
  validateBookingPreflight,
  bookingFollowUp,
  isBookingIntent,
  registryFacts,
  groundedPrompt,
  bookingPreflightPrompt,
  routePolicy,
} from "./policy.js";
import { cloudRequest, runtimeResponse } from "./messages.js";

export async function createConnection(configUrl) {
  const cacheKey = `gemihub-hybrid:config:${configUrl}`;
  let config;
  try {
    const response = await fetch(configUrl, { signal: AbortSignal.timeout(5000), cache: "no-cache" });
    if (!response.ok) throw new Error("Hybrid configuration unavailable.");
    config = await response.json();
    try { sessionStorage.setItem(cacheKey, JSON.stringify(config)); } catch { /* Optional cache. */ }
  } catch (error) {
    try { config = JSON.parse(sessionStorage.getItem(cacheKey)); } catch { /* Missing cache. */ }
    if (!config) throw error;
  }
  const hybrid = new HybridInference(config);
  let voice = false;
  try {
    const response = await fetch("/api/ai/config", { signal: AbortSignal.timeout(2000) });
    if (response.ok) voice = (await response.json()).voice === true;
  } catch { /* Static deployments need no voice backend. */ }
  // A compatibility session label for the unchanged runtime. It is not a key
  // and is never sent to a provider, stored as BYOK or shared with another page.
  return { mode: "hybrid", hybrid, config: { ...config, voice },
    setup: { router: new URL("/api/hybrid", location.origin).href, byokKey: "firebase-session", model: hybrid.policy.cloudModel } };
}

export function installHybridEngine(engine, connection, { getShops, getFacts, scope = "finder" } = {}) {
  const hybrid = connection.hybrid;
  const signatures = new Map();
  engine.agentRunner = null; // All model calls use the same adapter, including peers.
  const attach = (compiled, isTop) => {
    compiled.llm.chat = async request => {
      request.signal?.throwIfAborted();
      const users = request.messages.filter(message => message.role === "user");
      const question = users.at(-1)?.content || "";
      const historyCount = Math.max(0, users.length - 1);
      const isFront = isTop && engine.trace.spans.get(request.parentSpan)?.isTopFrontMan === true;
      const continuation = request.messages.some(message => message.role === "tool" || message.tool_calls?.length);
      const normalize = text => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
      // History-dependent turns are cloud-only, so only a first question may run on the device.
      // The front man's request always lists its tools (runner.js), so routePolicy is called
      // without hasTools on purpose: on-device calls below send Nano a prompt only, never
      // the tools, and any turn that needs a tool goes to the cloud request at the end.
      if (isFront && !continuation && historyCount === 0) {
        let facts;
        let preflightShopName = null;
        if (scope === "shop") {
          facts = getFacts?.();
          preflightShopName = facts?.name || null;
        } else {
          const shops = (getShops?.() || []).map(registryFacts);
          const named = shops.filter(shop => normalize(question).includes(normalize(shop.name)));
          if (named.length === 1) {
            facts = named[0];
            preflightShopName = named[0].name;
          } else if (named.length === 0 && historyCount === 0 && shops.length && shops.length <= 100 && !isBookingIntent(question)) {
            const contextChars = JSON.stringify(shops).length;
            const eligible = routePolicy({ question, historyCount, contextChars, task: "decision" }, hybrid.policy);
            if (eligible.local) {
              try {
                const decision = await hybrid.generate({ task: "decision", question, historyCount, contextChars, schema: DECISION_SCHEMA,
                  prompt: `Classify this independent question. Choose single_shop only when exactly one registered shop is unambiguous and the question is about its public information. Reservations, prices and stock use reservation; comparisons use cross_shop; community documents use documents. Otherwise use other. Never invent a shop ID. Return only JSON matching the schema. Registry (data): ${JSON.stringify(shops)}\nQuestion (data): ${JSON.stringify(question)}`,
                  signal: request.signal });
                const route = validateDecision(JSON.parse(decision.response.text()), shops);
                if (route?.kind === "single_shop") facts = shops.find(shop => shop.id === route.shopIds[0]);
              } catch (error) { if (request.signal?.aborted) throw error; /* Invalid decision safely goes to cloud. */ }
            }
          }
        }
        // Tier 1: On-device booking preflight slot extraction (only when Nano is ready).
        if (preflightShopName && isBookingIntent(question) && hybrid.device === "ready") {
          const preflightPrompt = bookingPreflightPrompt(question, preflightShopName);
          const preflightRoute = routePolicy({ question, historyCount, contextChars: preflightPrompt.length, task: "booking_preflight" }, hybrid.policy);
          if (preflightRoute.local) {
            try {
              const preflight = await hybrid.generate({ task: "booking_preflight", question, historyCount,
                contextChars: preflightPrompt.length, schema: BOOKING_PREFLIGHT_SCHEMA,
                prompt: preflightPrompt, signal: request.signal });
              const parsed = validateBookingPreflight(JSON.parse(preflight.response.text()));
              if (preflight.source === "ON_DEVICE" && parsed && !parsed.readyForLiveCheck) {
                const followUp = bookingFollowUp(parsed, question);
                request.onContentDelta?.(followUp);
                hybrid.emit({ answer: { ...preflight.log, finalAnswer: true } });
                return { content: followUp, toolCalls: [], model: "Gemini Nano" };
              }
            } catch (error) { if (request.signal?.aborted) throw error; /* Fall through to cloud + MCP. */ }
          }
        }
        // Tier 2: On-device grounded Q&A with streaming for published shop facts.
        if (facts) {
          const prompt = groundedPrompt(question, facts);
          if (routePolicy({ question, historyCount, task: "single_shop", contextChars: prompt.length }, hybrid.policy).local) {
            const onDelta = request.onContentDelta && ((delta, source) => {
              request.onContentDelta(delta);
              if (scope === "finder" && source === InferenceSource.ON_DEVICE && !request.signal?.aborted) {
                hybrid.emit({ faqDelta: delta });
              }
            });
            const generated = await hybrid.generate({ task: "single_shop", question, historyCount,
              contextChars: prompt.length, prompt, signal: request.signal, onDelta });
            const content = generated.response.text();
            if (!generated.streamed) request.onContentDelta?.(content);
            hybrid.emit({ answer: { ...generated.log, finalAnswer: true } });
            return { content, toolCalls: [], model: generated.source === "ON_DEVICE" ? "Gemini Nano" : hybrid.policy.cloudModel };
          }
        }
      }
      const converted = cloudRequest(request.messages, request.tools || [], signatures);
      const span = engine.trace.start("firebase_cloud", { parent: request.parentSpan, task: "agent" });
      try {
        const result = await hybrid.generate({ task: "agent", question, request: converted.request,
          systemInstruction: converted.systemInstruction, hasTools: !!request.tools?.length,
          historyCount, signal: request.signal });
        const answer = runtimeResponse(result.response, signatures);
        if (answer.content) request.onContentDelta?.(answer.content);
        // Only tools called in this turn: the messages after the latest user message.
        const turnStart = request.messages.findLastIndex(m => m.role === "user");
        const recentTools = [...new Set(request.messages.slice(turnStart + 1)
          .filter(m => m.role === "tool" && m.name).map(m => m.name))];
        if (isFront && !answer.toolCalls.length) hybrid.emit({ answer: { ...result.log, finalAnswer: true, tools: recentTools } });
        engine.trace.end(span, { source: result.source, toolCalls: answer.toolCalls.map(call => call.function.name) });
        return { ...answer, model: hybrid.policy.cloudModel };
      } catch (error) { engine.trace.fail(span, "Firebase inference failed"); throw error; }
    };
    return compiled;
  };
  attach(engine.top, true);
  const compile = engine._compile.bind(engine);
  engine._compile = async (...args) => attach(await compile(...args), args[3]?.isTop === true);
  return hybrid;
}

export async function readPublishedFacts(url) {
  const key = `gemihub-hybrid:facts:${url}`;
  try {
    const response = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("Published facts unavailable.");
    const facts = await response.json();
    try { sessionStorage.setItem(key, JSON.stringify(facts)); } catch { /* Optional cache. */ }
    return facts;
  } catch {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
  }
}

export function mountHybridControls(engine, connection) {
  const hybrid = connection.hybrid;
  const root = document.getElementById("agent-app");
  const english = document.documentElement.lang === "en";
  const label = (ja, en) => english ? en : ja;
  const dialog = document.getElementById("ai-setup-dialog");
  if (connection.config.demo) {
    const note = document.createElement("p"); note.className = "hybrid-demo-note"; note.setAttribute("role", "note");
    note.textContent = label("デモ版：架空のお店です。実際の予約・請求・連絡は行いません。",
      "Demo only: fictional shops. No real bookings, charges or calls are made.");
    (document.getElementById("assistant-status") || root).before(note);
  }
  // The upstream runtime stays unmodified; no provider/key inputs remain in
  // this product. Existing saved profiles are ignored by explicit boot options.
  for (const selector of [".ns-settings", "#ai-provider", "#ai-key-link"]) {
    const element = root.querySelector(selector);
    if (element) (selector === "#ai-provider" ? element.closest("label") : element).remove();
  }
  for (const element of root.querySelectorAll('[data-ns-slot="settings"]')) element.remove();
  document.getElementById("ai-setup-heading").textContent = label("端末内AIのセットアップ", "On-device AI setup");
  document.getElementById("ai-setup-description").textContent = label(
    "対応端末のデスクトップ版Chrome 149以降で、Gemini Nanoを準備できます。準備中もクラウドで質問できます。",
    "Gemini Nano runs on compatible computers with desktop Chrome 149 or later. You can keep chatting in the cloud during setup.");
  const steps = document.createElement("ol");
  steps.className = "hybrid-setup-steps";
  const flagStep = document.createElement("li");
  flagStep.textContent = label("次のアドレスをChromeのアドレスバーに貼り付けます。",
    "Paste this address into the Chrome address bar.");
  const flagRow = document.createElement("div"); flagRow.className = "hybrid-flag";
  const flag = document.createElement("input");
  flag.type = "text"; flag.readOnly = true; flag.spellcheck = false;
  flag.value = "chrome://flags/#prompt-api-for-gemini-nano-multimodal-input";
  flag.setAttribute("aria-label", label("Chromeの設定アドレス", "Chrome flag address"));
  flag.addEventListener("focus", () => flag.select());
  const copy = document.createElement("button"); copy.type = "button";
  copy.textContent = label("コピー", "Copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(flag.value);
      copy.textContent = label("コピー済み", "Copied");
    } catch {
      flag.focus();
      flag.select();
    }
  });
  flagRow.append(flag, copy);
  flagStep.append(flagRow);
  const relaunch = document.createElement("li");
  relaunch.textContent = label("設定を Enabled にして、Chromeを再起動し、このページに戻ります。",
    "Switch the flag to Enabled, relaunch Chrome, then return here.");
  const download = document.createElement("li");
  download.textContent = label("「端末内AIを準備する」を押します。初回はダウンロードに数分かかることがあります。",
    "Click Prepare on-device AI below. The first download may take a few minutes.");
  steps.append(flagStep, relaunch, download);
  const requirements = document.createElement("a");
  requirements.href = "https://developer.chrome.com/docs/ai/get-started#hardware";
  requirements.target = "_blank"; requirements.rel = "noopener noreferrer";
  requirements.textContent = label("Chromeの動作要件", "Chrome hardware requirements");
  const panel = document.createElement("section"); panel.className = "hybrid-controls";
  const prepare = document.createElement("button"); prepare.type = "button";
  prepare.textContent = label("端末内AIを準備する", "Prepare on-device AI");
  const device = document.createElement("p"); device.setAttribute("role", "status");
  device.textContent = label("準備ができるまではクラウドで回答します。", "Answers use the cloud until on-device AI is ready.");
  const details = document.createElement("details"); const summary = document.createElement("summary");
  summary.textContent = label("推論の記録", "Inference details");
  const log = document.createElement("ol"); log.className = "hybrid-log"; details.append(summary, log);
  panel.append(steps, prepare, device, requirements, details);
  const close = document.getElementById("ai-setup-close");
  dialog.insertBefore(panel, close?.parentElement === dialog ? close : null);
  const badge = document.createElement("span"); badge.id = "hybrid-inference-badge";
  badge.className = "hybrid-badge"; badge.setAttribute("role", "status");
  badge.textContent = label("回答待ち", "Awaiting answer");
  (document.querySelector(".assistant-sidebar-header") || root.querySelector(".ns-header"))?.append(badge);
  const formatTelemetry = entry => {
    const modelName = entry.model || (entry.source === "ON_DEVICE" ? "Gemini Nano" : hybrid.policy.cloudModel);
    const ms = Number.isFinite(entry.durationMs) ? `${entry.durationMs.toLocaleString()} ms`
      + (Number.isFinite(entry.firstTokenMs) ? ` (${label("初回表示", "first token")} ${entry.firstTokenMs.toLocaleString()} ms)` : "") : "";
    const parts = [
      entry.source === "ON_DEVICE" ? label("⚡ 端末内", "⚡ On-device")
        : entry.source === "IN_CLOUD" ? label("☁ クラウド", "☁ Cloud")
        : label("推論元未確認", "Source unverified"),
      modelName,
      ms,
    ].filter(Boolean);
    if (entry.reason) {
      let detail = entry.reason;
      if (entry.source === "ON_DEVICE" && entry.task === "booking_preflight") detail += " (JSON Schema)";
      else if (entry.source === "ON_DEVICE" && entry.contextChars && entry.maxContextChars)
        detail += ` (${entry.contextChars.toLocaleString()} / ${entry.maxContextChars.toLocaleString()} chars)`;
      if (Array.isArray(entry.tools) && entry.tools.length) detail += ` (MCP: ${entry.tools.join(", ")})`;
      parts.push(detail);
    }
    return parts.join(" · ");
  };
  const updateBadge = entry => {
    badge.dataset.source = entry.source;
    badge.textContent = entry.source === "ON_DEVICE" ? label("⚡ 端末内", "⚡ On-device")
      : entry.source === "IN_CLOUD" ? label("☁ クラウド", "☁ Cloud") : label("推論元を確認できません", "Source unverified");
    badge.title = formatTelemetry(entry);
    // The answer bubble is only rendered after turn.completed, so the label
    // waits for it instead of landing on the status line or the previous answer.
    pendingLabel = entry;
  };
  let pendingLabel = null;
  const messages = root.querySelector("#ns-msgs");
  const inputBar = root.querySelector(".ns-inputbar");
  let preview = null;
  const clearPreview = () => {
    preview?.remove();
    preview = null;
  };
  const transient = ".ns-turn-status,.hybrid-faq-preview,.ns-linker,.ns-consent,.carried-conditions,.finder-results,.finder-introductions,.finder-inquiry";
  const attachLabel = (bubble, entry) => {
    bubble.dataset.inferenceSource = entry.source;
    const pill = document.createElement("div");
    pill.className = "hybrid-telemetry-pill";
    pill.dataset.source = entry.source;
    pill.textContent = formatTelemetry(entry);
    bubble.append(pill);
  };
  const labelObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes" && inputBar.dataset.turnActive !== "true") clearPreview();
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !node.matches(".ns-msg") || node.closest("#ns-msgs") !== messages) continue;
        if (node.matches(".user")) {
          pendingLabel = null;
          clearPreview();
        } else if (node.matches(".bot") && !node.matches(transient)) {
          clearPreview();
          if (pendingLabel) {
            attachLabel(node, pendingLabel);
            pendingLabel = null;
          }
        }
      }
    }
  });
  labelObserver.observe(root, { childList: true, subtree: true });
  if (inputBar) labelObserver.observe(inputBar, { attributes: true, attributeFilter: ["data-turn-active"] });
  const syncDeviceState = (state, progress) => {
    prepare.disabled = ["preparing", "downloading", "ready"].includes(state);
    device.textContent = state === "ready" ? label("端末内AIの準備ができました。", "On-device AI is ready.")
      : state === "unavailable" ? label("この環境では端末内AIが使えません。クラウドで続行します。", "Local AI is unavailable here. Chat continues in the cloud.")
      : state === "downloading" ? `${label("モデルをダウンロード中", "Downloading model")} ${Math.round((progress || 0) * 100)}%`
      : state === "preparing" ? label("端末内AIを準備中…クラウドで相談を続けられます。", "Preparing local AI… You can continue using cloud chat.")
      : label("準備ができるまではクラウドで回答します。", "Answers use the cloud until on-device AI is ready.");
  };
  syncDeviceState(hybrid.device);
  const unsubscribe = hybrid.subscribe(event => {
    if (event.faqDelta && messages && inputBar?.dataset.turnActive === "true") {
      const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
      if (!preview) {
        preview = document.createElement("div");
        preview.className = "ns-msg bot hybrid-faq-preview";
        preview.setAttribute("aria-hidden", "true");
        messages.append(preview);
      }
      // The final bubble is rendered and labelled by the existing turn handler.
      preview.append(event.faqDelta);
      if (atBottom) messages.scrollTop = messages.scrollHeight;
    }
    if (event.device) syncDeviceState(event.device, event.progress);
    if (event.log) {
      const entry = event.log; const item = document.createElement("li");
      item.textContent = `${entry.task} · ${entry.source} · ${entry.durationMs} ms${Number.isFinite(entry.firstTokenMs) ? ` (TTFT ${entry.firstTokenMs} ms)` : ""} · ${entry.reason}${entry.fallback ? " · fallback" : ""}${entry.error ? ` · ${entry.error} · ${entry.errorCode || "unknown"}${entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : ""}` : ""}`;
      log.prepend(item); while (log.children.length > 30) log.lastElementChild.remove();
      if (entry.finalAnswer) updateBadge(entry);
    }
    if (event.answer) updateBadge(event.answer);
  });
  const isShopPage = document.documentElement.dataset.agentKind === "shop" || /^\/s\//.test(location.pathname);
  const quickPrompts = isShopPage ? [
    { kind: "local", tag: label("⚡ 端末内FAQ", "⚡ Local FAQ"), prompt: label("営業時間とメニューを教えて", "What are your opening hours and menu items?") },
    { kind: "hybrid", tag: label("⚡→☁ 予約プリフライト", "⚡→☁ Hybrid Booking"), prompt: label("金曜日に予約したいです", "I would like to make a reservation for Friday") },
    { kind: "cloud", tag: label("☁ クラウド空席確認", "☁ Cloud Live Check"), prompt: label("明日の19時に2名で空席を確認して", "Check availability for 2 guests tomorrow at 19:00") },
  ] : [
    { kind: "local", tag: label("⚡ 端末内FAQ", "⚡ Local FAQ"), prompt: label("炉端 灯の営業時間とメニューを教えて", "What are Robata Akari's opening hours and menu items?") },
    { kind: "hybrid", tag: label("⚡→☁ ハイブリッド予約", "⚡→☁ Hybrid Handoff"), prompt: label("今週金曜に炉端 灯を予約したい", "I want to book Robata Akari this Friday") },
    { kind: "cloud", tag: label("☁ 複数店舗比較", "☁ Cloud Multi-Shop"), prompt: label("トラットリア・ソーレと広東 龍を比較して", "Compare Trattoria Sole and Canton Ryu for a group dinner") },
  ];
  if (inputBar && !root.querySelector(".hybrid-quick-chips")) {
    const chips = document.createElement("div");
    chips.className = "hybrid-quick-chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", label("ハイブリッド推論の検証プロンプト", "Hybrid inference quick prompts"));
    for (const item of quickPrompts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hybrid-chip";
      btn.dataset.kind = item.kind;
      btn.textContent = item.tag;
      btn.title = item.prompt;
      btn.addEventListener("click", () => {
        const input = root.querySelector("#ns-input");
        const send = root.querySelector("#ns-send");
        if (!input || inputBar.dataset.turnActive === "true") return;
        input.value = item.prompt;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (send && !send.disabled) send.click();
        else input.focus();
      });
      chips.append(btn);
    }
    inputBar.before(chips);
  }
  const start = () => { void hybrid.prepareDevice(); };
  prepare.addEventListener("click", start);
  root.querySelector("#ns-send")?.addEventListener("click", start, { capture: true });
  root.querySelector("#ns-input")?.addEventListener("keydown", event => { if (event.key === "Enter") start(); }, { capture: true });
  const open = document.getElementById("ai-settings-open");
  open.classList.add("hybrid-settings-open");
  open.disabled = false; open.textContent = label("端末内AIをセットアップ", "Set up on-device AI");
  open.setAttribute("aria-haspopup", "dialog");
  open.addEventListener("click", () => dialog.showModal());
  close?.addEventListener("click", () => dialog.close());
  for (const id of ["assistant-key-note", "assistant-privacy-note"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = document.getElementById("ai-setup-description").textContent;
  }
  const oldBadge = root.querySelector(".ns-llmbadge");
  if (oldBadge) oldBadge.remove();
  window.addEventListener("pagehide", () => { unsubscribe(); labelObserver.disconnect(); }, { once: true });
  return { openIfNeeded() {}, hybrid };
}
