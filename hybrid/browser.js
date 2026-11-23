import { HybridInference } from "./firebase-client.js";
import { DECISION_SCHEMA, validateDecision, registryFacts, groundedPrompt, routePolicy } from "./policy.js";
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
      const isFront = isTop && engine.trace.spans.get(request.parentSpan)?.isTopFrontMan === true;
      const continuation = request.messages.some(message => message.role === "tool" || message.tool_calls?.length);
      let facts;
      if (isFront && !continuation && users.length === 1) {
        if (scope === "shop") facts = getFacts?.();
        else {
          const shops = (getShops?.() || []).map(registryFacts);
          const contextChars = JSON.stringify(shops).length;
          const eligible = routePolicy({ question, contextChars, task: "decision" }, hybrid.policy);
          const normalize = text => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
          const named = shops.filter(shop => normalize(question).includes(normalize(shop.name)));
          if (eligible.local && named.length === 1) facts = named[0];
          else if (eligible.local && named.length === 0 && shops.length && shops.length <= 100) {
            try {
              const decision = await hybrid.generate({ task: "decision", question, contextChars, schema: DECISION_SCHEMA,
                prompt: `Classify this independent question. Choose single_shop only when exactly one registered shop is unambiguous and the question is about its public information. Reservations, prices and stock use reservation; comparisons use cross_shop; community documents use documents. Otherwise use other. Never invent a shop ID. Return only JSON matching the schema. Registry (data): ${JSON.stringify(shops)}\nQuestion (data): ${JSON.stringify(question)}`,
                signal: request.signal });
              const route = validateDecision(JSON.parse(decision.response.text()), shops);
              if (route?.kind === "single_shop") facts = shops.find(shop => shop.id === route.shopIds[0]);
            } catch (error) { if (request.signal?.aborted) throw error; /* Invalid decision safely goes to cloud. */ }
          }
        }
        if (facts && routePolicy({ question, task: "single_shop", contextChars: JSON.stringify(facts).length }, hybrid.policy).local) {
          const generated = await hybrid.generate({ task: "single_shop", question, contextChars: JSON.stringify(facts).length,
            prompt: groundedPrompt(question, facts), signal: request.signal });
          const content = generated.response.text();
          request.onContentDelta?.(content);
          hybrid.emit({ answer: { ...generated.log, finalAnswer: true } });
          return { content, toolCalls: [], model: generated.source === "ON_DEVICE" ? "Gemini Nano" : hybrid.policy.cloudModel };
        }
      }
      const converted = cloudRequest(request.messages, request.tools || [], signatures);
      const span = engine.trace.start("firebase_cloud", { parent: request.parentSpan, task: "agent" });
      try {
        const result = await hybrid.generate({ task: "agent", question, request: converted.request,
          systemInstruction: converted.systemInstruction, hasTools: !!request.tools?.length,
          historyCount: users.length - 1, signal: request.signal });
        const answer = runtimeResponse(result.response, signatures);
        if (answer.content) request.onContentDelta?.(answer.content);
        if (isFront && !answer.toolCalls.length) hybrid.emit({ answer: { ...result.log, finalAnswer: true } });
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
  document.getElementById("ai-setup-description").textContent = label(
    "簡単な質問は端末内で処理し、端末内AIが使えない場合や予約の相談はFirebase経由でクラウドへ送ります。APIキーの入力は不要です。",
    "Simple questions can run on your device. Unsupported devices and complex or reservation conversations use the cloud through Firebase. No API key is needed.");
  const panel = document.createElement("section"); panel.className = "hybrid-controls";
  const prepare = document.createElement("button"); prepare.type = "button";
  prepare.textContent = label("端末内AIを準備する", "Prepare on-device AI");
  const device = document.createElement("p"); device.setAttribute("role", "status");
  device.textContent = label("Chromeで端末内AIを準備できます。未準備の場合はクラウドを使います。", "Prepare local AI in supported desktop Chrome. Until then, answers use the cloud.");
  const details = document.createElement("details"); const summary = document.createElement("summary");
  summary.textContent = label("推論の記録", "Inference details");
  const log = document.createElement("ol"); log.className = "hybrid-log"; details.append(summary, log);
  panel.append(prepare, device, details); dialog.append(panel);
  const badge = document.createElement("span"); badge.id = "hybrid-inference-badge";
  badge.className = "hybrid-badge"; badge.setAttribute("role", "status");
  badge.textContent = label("回答待ち", "Awaiting answer");
  (document.querySelector(".assistant-sidebar-header") || root.querySelector(".ns-header"))?.append(badge);
  const updateBadge = entry => {
    badge.dataset.source = entry.source;
    badge.textContent = entry.source === "ON_DEVICE" ? label("端末内", "On-device")
      : entry.source === "IN_CLOUD" ? label("クラウド", "Cloud") : label("推論元を確認できません", "Source unverified");
    badge.title = `${entry.durationMs} ms`;
    const latest = [...root.querySelectorAll("#ns-msgs .ns-msg.bot")].at(-1);
    if (latest) latest.dataset.inferenceSource = entry.source;
  };
  const unsubscribe = hybrid.subscribe(event => {
    if (event.device) {
      const state = event.device;
      prepare.disabled = ["preparing", "downloading", "ready"].includes(state);
      device.textContent = state === "ready" ? label("端末内AIの準備ができました。", "On-device AI is ready.")
        : state === "unavailable" ? label("この環境では端末内AIが使えません。クラウドで続行します。", "Local AI is unavailable here. Chat continues in the cloud.")
        : state === "downloading" ? `${label("モデルをダウンロード中", "Downloading model")} ${Math.round(event.progress * 100)}%`
        : label("端末内AIを準備中…クラウドで相談を続けられます。", "Preparing local AI… You can continue using cloud chat.");
    }
    if (event.log) {
      const entry = event.log; const item = document.createElement("li");
      item.textContent = `${entry.task} · ${entry.source} · ${entry.durationMs} ms · ${entry.reason}${entry.fallback ? " · fallback" : ""}${entry.error ? ` · ${entry.error} · ${entry.errorCode || "unknown"}` : ""}`;
      log.prepend(item); while (log.children.length > 30) log.lastElementChild.remove();
      if (entry.finalAnswer) updateBadge(entry);
    }
    if (event.answer) updateBadge(event.answer);
  });
  const start = () => { void hybrid.prepareDevice(); };
  prepare.addEventListener("click", start);
  root.querySelector("#ns-send")?.addEventListener("click", start, { capture: true });
  root.querySelector("#ns-input")?.addEventListener("keydown", event => { if (event.key === "Enter") start(); }, { capture: true });
  const open = document.getElementById("ai-settings-open");
  open.classList.add("hybrid-settings-open");
  open.disabled = false; open.textContent = label("AIの処理と設定", "AI processing and settings");
  open.addEventListener("click", () => dialog.showModal());
  document.getElementById("ai-setup-close")?.addEventListener("click", () => dialog.close());
  for (const id of ["assistant-key-note", "assistant-privacy-note"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = document.getElementById("ai-setup-description").textContent;
  }
  const oldBadge = root.querySelector(".ns-llmbadge");
  if (oldBadge) oldBadge.remove();
  window.addEventListener("pagehide", unsubscribe, { once: true });
  return { openIfNeeded() {}, hybrid };
}
