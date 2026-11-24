import test from "node:test";
import assert from "node:assert/strict";
import { InferenceMode, InferenceSource } from "firebase/ai";
import { HybridInference } from "../hybrid/firebase-client.js";
import {
  boundedPolicy,
  routePolicy,
  validateDecision,
  validateBookingPreflight,
  bookingFollowUp,
  registryFacts,
} from "../hybrid/policy.js";
import { cloudRequest, runtimeResponse } from "../hybrid/messages.js";
import { installHybridEngine } from "../hybrid/browser.js";
import { handleTownMcpMessage, createTownMcpHandler } from "../scripts/town-mcp.mjs";

test("tools, deep/dependent history, comparisons and live transactional questions cannot be routed locally", () => {
  const policy = boundedPolicy({ localQuestionChars: 999999, localContextChars: 999999 });
  assert.equal(policy.localQuestionChars, 2000);
  assert.equal(policy.localContextChars, 16000);
  for (const value of [
    { question: "営業時間は？", hasTools: true },
    { question: "営業時間は？", historyCount: 1 },
    { question: "メニューを教えて", historyCount: 1 },
    { question: "その店は何時から？" },
    { question: "2店を比較して" },
    { question: "この店を予約したい" },
    { question: "What is the total price?" },
    { question: "Is it safe for my allergy?" },
    { question: "I have a nut allergy, which dishes can I eat?" },
    { question: "エビアレルギーでも食べられるメニューは？" },
    { question: "4人だと予算はいくら？" },
    { question: "How much would the course cost for 4 people?" },
    { question: "コース料金とメニューを教えて" },
  ]) assert.equal(routePolicy({ task: "single_shop", ...value }, policy).local, false, JSON.stringify(value));
  assert.equal(routePolicy({ question: "予約したい", task: "booking_preflight", historyCount: 1 }, policy).local, false);
  assert.equal(routePolicy({ question: "予約したい", task: "booking_preflight" }, policy).local, true);
  assert.equal(routePolicy({ question: "炉端 灯の住所は？", task: "single_shop" }, policy).local, true);
  assert.equal(routePolicy({ question: "コースのメニューを教えて", task: "single_shop" }, policy).local, true);
  assert.equal(routePolicy({ question: "ベジタリアン対応はある？", task: "single_shop" }, policy).local, true);
  assert.equal(routePolicy({ question: "Where is the shop?", contextChars: 16001 }, policy).local, false);
});

test("routing decisions accept only known shop IDs and the exact schema", () => {
  const shops = [{ id: "akari" }];
  for (const value of [null, { kind: "single_shop", shopIds: ["unknown"] },
    { kind: "single_shop", shopIds: [] }, { kind: "single_shop", shopIds: ["akari", "akari"] },
    { kind: "single_shop", shopIds: ["akari"], tool: "place_reservation" }])
    assert.equal(validateDecision(value, shops), null);
  assert.deepEqual(validateDecision({ kind: "single_shop", shopIds: ["akari"] }, shops), { kind: "single_shop", shopIds: ["akari"] });
  const facts = registryFacts({ id: "akari", name: "Akari", address: "Published address", owner: "private", bookings: ["private"], otherShop: "private" });
  assert.deepEqual(Object.keys(facts), ["id", "name", "address"]);
});

test("tool-call round trip preserves provider IDs and raw thought signatures", () => {
  const signatures = new Map();
  const parts = [{ type: "functionCall", functionCall: { id: "provider-1", name: "check_availability", args: { partySize: 2 } }, thoughtSignature: "test-signature" },
    { type: "functionCall", functionCall: { id: "provider-2", name: "get_shop_info", args: {} } }];
  const result = runtimeResponse({ candidates: [{ content: { role: "model", parts } }] }, signatures);
  const messages = [{ role: "system", content: "Keep the existing booking rules." }, { role: "user", content: "Two seats?" },
    { role: "assistant", content: "", tool_calls: result.toolCalls },
    { role: "tool", name: "check_availability", tool_call_id: "provider-1", content: '{"fits":true}' },
    { role: "tool", name: "get_shop_info", tool_call_id: "provider-2", content: '{"shop":"Akari"}' }];
  const converted = cloudRequest(messages, [], signatures);
  assert.equal(converted.systemInstruction, messages[0].content);
  assert.equal(converted.request.contents[1].parts[0].thoughtSignature, "test-signature");
  assert.equal(converted.request.contents[2].role, "user");
  assert.equal(converted.request.contents[2].parts[0].functionResponse.id, "provider-1");
  assert.equal(converted.request.contents[2].parts.length, 2);
  messages[2].tool_calls[0].function.arguments = '{"partySize":200}';
  assert.throws(() => cloudRequest(messages, [], signatures), /changed/);
});

test("actual SDK inferenceSource controls badges/logs, independently of the requested mode", async () => {
  let source = InferenceSource.IN_CLOUD;
  const configurations = [];
  const hybrid = new HybridInference({ cloudModel: "gemini-4-hydrogen" }, { ai: {}, now: () => 10,
    factory: (_ai, config) => { configurations.push(config); return { generateContent: async () => ({ response: { inferenceSource: source } }) }; } });
  hybrid.device = "ready";
  await hybrid.prepareDevice();
  assert.equal(hybrid.device, "ready");
  const options = { task: "single_shop", question: "What are the opening hours?", prompt: "Published facts only" };
  const fallback = await hybrid.generate(options);
  assert.equal(configurations[0].mode, InferenceMode.PREFER_ON_DEVICE);
  assert.equal(fallback.source, "IN_CLOUD"); assert.equal(fallback.log.fallback, true);
  assert.equal(fallback.log.fallbackReason, "unknown");
  source = InferenceSource.ON_DEVICE;
  const local = await hybrid.generate(options);
  assert.equal(local.source, "ON_DEVICE"); assert.equal(local.log.fallback, false);
  await hybrid.generate({ ...options, hasTools: true });
  assert.equal(configurations.at(-1).mode, InferenceMode.ONLY_IN_CLOUD);
  assert.equal(JSON.stringify(hybrid.logs).includes("Published facts only"), false);
  assert.equal(configurations[0].inCloudParams.model, "gemini-4-hydrogen");
});

test("empty and truncated cloud responses never finish silently or execute partial tools", () => {
  assert.throws(() => runtimeResponse({ candidates: [{ finishReason: "MAX_TOKENS", content: {
    parts: [{ functionCall: { name: "confirm_reservation", args: {} } }] } }] }), /Incomplete/);
  assert.throws(() => runtimeResponse({ candidates: [{ finishReason: "STOP", content: {
    parts: [{ text: "Reasoning summary", thought: true }] } }] }), /no answer/);
});

test("quota failures remain distinct from model unavailability and retain no request text", async () => {
  const hybrid = new HybridInference({}, { ai: {}, factory: () => ({ generateContent: async () => {
    const error = new Error("Private provider details"); error.code = "fetch-error";
    error.customErrorData = { status: 429 }; throw error;
  } }) });
  await assert.rejects(hybrid.generate({ task: "agent", question: "Private request", prompt: "Private request", hasTools: true }), /利用上限/);
  assert.equal(hybrid.logs.at(-1).httpStatus, 429);
  assert.equal(hybrid.logs.at(-1).errorCode, "fetch-error");
  assert.doesNotMatch(JSON.stringify(hybrid.logs), /Private/);
});

function engineFixture() {
  const calls = [];
  const hybrid = { policy: boundedPolicy(), emit() {}, generate: async input => {
    calls.push(input);
    if (input.task === "decision") return { response: { text: () => '{"kind":"single_shop","shopIds":["akari"]}' } };
    return { response: { text: () => "Published answer", candidates: [{ content: { parts: [{ type: "text", text: "Cloud answer" }] } }] }, log: {}, source: "IN_CLOUD" };
  } };
  const engine = { top: { llm: {} }, _compile: async () => ({ llm: {} }),
    trace: { spans: new Map([["front", { isTopFrontMan: true }]]), start() {}, end() {}, fail() {} } };
  installHybridEngine(engine, { hybrid }, { getShops: () => [{ id: "akari", name: "Akari", address: "A street", owner: "secret" }, { id: "other", name: "Other shop" }] });
  return { engine, hybrid, calls };
}

test("finder uses isolated shop facts; multi-turn and peer tool calls remain cloud-only", async () => {
  const { engine, calls } = engineFixture();
  const request = { parentSpan: "front", messages: [{ role: "user", content: "Where is Akari?" }], tools: [] };
  const answer = await engine.top.llm.chat(request);
  assert.equal(answer.content, "Published answer");
  const local = calls.find(call => call.task === "single_shop");
  assert.ok(local.prompt.includes("A street"));
  assert.ok(!local.prompt.includes("Other shop")); assert.ok(!local.prompt.includes("secret"));
  calls.length = 0;
  await engine.top.llm.chat({ ...request, messages: [...request.messages, { role: "assistant", content: answer.content }, { role: "user", content: "And the hours?" }] });
  assert.equal(calls.length, 1); assert.equal(calls[0].task, "agent"); assert.equal(calls[0].historyCount, 1);
  const peer = await engine._compile("base", {}, {}, { isTop: false });
  calls.length = 0;
  await peer.llm.chat({ ...request, tools: [{ function: { name: "get_shop_info", parameters: { type: "object", properties: {} } } }] });
  assert.equal(calls[0].hasTools, true); assert.equal(calls[0].task, "agent");
});

test("invalid classification cannot invent a local shop context", async () => {
  const { engine, hybrid, calls } = engineFixture();
  const generate = hybrid.generate;
  hybrid.generate = async input => input.task === "decision"
    ? { response: { text: () => '{"kind":"single_shop","shopIds":["not-registered"]}' } } : generate(input);
  await engine.top.llm.chat({ parentSpan: "front", messages: [{ role: "user", content: "Where is the nearby restaurant?" }], tools: [] });
  assert.equal(calls.length, 1); assert.equal(calls[0].task, "agent");
});

test("startup availability probe and 250ms preparation race eliminate first-turn cloud forcing", async () => {
  const originalLM = globalThis.LanguageModel;
  try {
    globalThis.LanguageModel = { availability: async () => "available" };
    const modes = [];
    const hybrid = new HybridInference({}, { ai: {}, now: () => 50,
      factory: (_ai, config) => {
        modes.push(config.mode);
        return {
          initializeDeviceModel: async () => {},
          generateContent: async () => ({ response: { inferenceSource: InferenceSource.ON_DEVICE } }),
        };
      } });
    await hybrid.probeAvailability();
    assert.equal(hybrid.device, "ready");
    const first = await hybrid.generate({ task: "single_shop", question: "What are the hours?", prompt: "Facts" });
    assert.equal(modes.at(-1), InferenceMode.PREFER_ON_DEVICE);
    assert.equal(first.source, "ON_DEVICE");

    // Simulate click-triggered prepareDevice() resolving quickly while generate() starts.
    const racing = new HybridInference({}, { ai: {}, now: () => 50,
      factory: (_ai, config) => {
        modes.push(config.mode);
        return {
          initializeDeviceModel: () => new Promise(resolve => setTimeout(resolve, 15)),
          generateContent: async () => ({ response: { inferenceSource: InferenceSource.ON_DEVICE } }),
        };
      } });
    void racing.prepareDevice();
    assert.equal(racing.device, "preparing");
    const raced = await racing.generate({ task: "single_shop", question: "What are the hours?", prompt: "Facts" });
    assert.equal(modes.at(-1), InferenceMode.PREFER_ON_DEVICE);
    assert.equal(raced.source, "ON_DEVICE");
  } finally {
    globalThis.LanguageModel = originalLM;
  }
});

test("streaming local answers emit deltas incrementally without duplicate full-text replay", async () => {
  const chunks = [];
  const hybrid = new HybridInference({}, { ai: {}, now: () => 100,
    factory: () => ({
      generateContentStream: async () => ({
        stream: (async function* () {
          yield { text: () => "Open " };
          yield { text: () => "17:00-23:30." };
        })(),
        response: Promise.resolve({ inferenceSource: InferenceSource.ON_DEVICE, text: () => "Open 17:00-23:30." }),
      }),
    }) });
  hybrid.device = "ready";
  const result = await hybrid.generate({
    task: "single_shop",
    question: "What are the hours?",
    prompt: "Published facts",
    onDelta: delta => chunks.push(delta),
  });
  assert.equal(result.streamed, true);
  assert.equal(result.source, "ON_DEVICE");
  assert.deepEqual(chunks, ["Open ", "17:00-23:30."]);
});

test("a stream that stalls after its first chunk still ends when the turn is aborted", async () => {
  const chunks = [];
  const hybrid = new HybridInference({}, { ai: {}, now: () => 100,
    factory: () => ({
      generateContentStream: async () => ({
        stream: (async function* () {
          yield { text: () => "Open " };
          await new Promise(() => {}); // Never yields again and ignores the signal.
        })(),
        response: new Promise(() => {}),
      }),
    }) });
  hybrid.device = "ready";
  const controller = new AbortController();
  const pending = hybrid.generate({ task: "single_shop", question: "What are the hours?", prompt: "Published facts",
    signal: controller.signal, onDelta: delta => { chunks.push(delta); setTimeout(() => controller.abort(new Error("stopped")), 10); } });
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(chunks, ["Open "]);
});

test("on-device booking preflight asks for missing slots locally and hands off when complete", async () => {
  assert.equal(validateBookingPreflight({ readyForLiveCheck: false, missingQuestion: "" }), null);
  assert.equal(validateBookingPreflight({ readyForLiveCheck: false, partySize: 0, missingQuestion: "When?" }), null);
  assert.deepEqual(
    validateBookingPreflight({ readyForLiveCheck: false, date: "2026-11-27", time: "19:00", partySize: 2, missingQuestion: "ignored" }),
    { readyForLiveCheck: true, date: "2026-11-27", time: "19:00", partySize: 2, missingQuestion: "" },
  );

  assert.deepEqual(
    validateBookingPreflight({ readyForLiveCheck: false, date: "Friday", missingQuestion: "Your table is reserved!" }),
    { readyForLiveCheck: false, date: "Friday", time: "", partySize: null },
  );
  assert.equal(bookingFollowUp({ date: "金曜" }, "金曜に予約したい"), "空席をお調べするため、時間・人数を教えてください。");
  assert.equal(bookingFollowUp({}, "book a table"), "To check availability, please tell me the date, the time and the number of guests.");

  const calls = [];
  // A model that claims a confirmation must never have its text shown.
  let preflightReply = '{"readyForLiveCheck":false,"date":"Friday","missingQuestion":"Great, your table on Friday is reserved!"}';
  const hybrid = {
    device: "ready",
    policy: boundedPolicy(),
    emit() {},
    generate: async input => {
      calls.push(input);
      if (input.task === "booking_preflight") {
        return { response: { text: () => preflightReply }, source: "ON_DEVICE", log: { task: "booking_preflight", source: "ON_DEVICE" } };
      }
      return { response: { text: () => "Cloud MCP check", candidates: [{ content: { parts: [{ type: "text", text: "Cloud MCP check" }] } }] }, source: "IN_CLOUD", log: { task: "agent", source: "IN_CLOUD" } };
    },
  };
  const engine = { top: { llm: {} }, _compile: async () => ({ llm: {} }),
    trace: { spans: new Map([["front", { isTopFrontMan: true }]]), start() {}, end() {}, fail() {} } };
  installHybridEngine(engine, { hybrid }, { scope: "shop", getFacts: () => ({ id: "akari", name: "Robata Akari", hours: "17:00-23:30" }) });

  const incomplete = await engine.top.llm.chat({ parentSpan: "front", messages: [{ role: "user", content: "I want to book this Friday" }], tools: [] });
  assert.equal(incomplete.content, "To check availability, please tell me the time and the number of guests.");
  assert.equal(incomplete.model, "Gemini Nano");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, "booking_preflight");

  calls.length = 0;
  preflightReply = '{"readyForLiveCheck":true,"date":"Friday","time":"19:00","partySize":2,"missingQuestion":""}';
  const complete = await engine.top.llm.chat({ parentSpan: "front", messages: [
    { role: "user", content: "I want to book this Friday" },
    { role: "assistant", content: "What time and how many guests?" },
    { role: "user", content: "19:00 for 2 guests" },
  ], tools: [] });
  assert.equal(complete.content, "Cloud MCP check");
  assert.equal(calls.at(-1).task, "agent");
  assert.equal(calls.length, 1, "a turn with history skips the on-device preflight");
});

test("town guide public MCP exposes read-only shop list, shop facts, and local event search", () => {
  const data = {
    shops: [
      { id: "akari", name: "Robata Akari", area: "Nakazakicho, Osaka", cuisine: "Japanese robata", hours: "17:00 - 23:30", products: ["Winter robata course"] },
      { id: "trattoria-sole", name: "Trattoria Sole", area: "Nakazakicho, Osaka", cuisine: "Italian", hours: "18:00 - 23:30", products: ["Margherita pizza"] },
    ],
    documents: [
      { id: "doc-1", name: "Nakazakicho Autumn Market", updatedAt: "2026-11-20", text: "Weekend craft and food market in Nakazakicho." },
    ],
  };
  const init = handleTownMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, data);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "gemihub-town-guide");

  const list = handleTownMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_town_shops", arguments: { cuisine: "italian" } } }, data);
  assert.equal(list.body.result.structuredContent.count, 1);
  assert.equal(list.body.result.structuredContent.shops[0].id, "trattoria-sole");

  const facts = handleTownMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query_shop_facts", arguments: { shopId: "akari" } } }, data);
  assert.equal(facts.body.result.structuredContent.found, true);
  assert.equal(facts.body.result.structuredContent.shop.hours, "17:00 - 23:30");

  const events = handleTownMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_local_events", arguments: { query: "market" } } }, data);
  assert.equal(events.body.result.isError, false);
  assert.equal(events.body.result.structuredContent.results.length, 1);
});

test("town MCP rate limit keys on the proxy-written hop, not a spoofed X-Forwarded-For", async () => {
  const handler = createTownMcpHandler({ siteDir: "does-not-exist" });
  const call = async spoofed => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    const req = { method: "POST", headers: { "x-forwarded-for": `${spoofed}, 203.0.113.7` },
      socket: { remoteAddress: "10.0.0.2" }, async *[Symbol.asyncIterator]() { yield body; } };
    let status;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end() {} };
    await handler(req, res);
    return status;
  };
  for (let i = 0; i < 60; i++) assert.equal(await call(`198.51.100.${i}`), 200);
  assert.equal(await call("198.51.100.250"), 429);
});

test("query_shop_facts never returns the first of several partial name matches", () => {
  const data = { documents: [], shops: [
    { id: "akari", name: "Robata Akari" },
    { id: "trattoria-sole", name: "Trattoria Sole" },
  ] };
  const facts = args => handleTownMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "query_shop_facts", arguments: args } }, data).body.result.structuredContent;
  assert.equal(facts({ shopName: "a" }).found, false);
  assert.equal(facts({ shopName: "a" }).ambiguous, true);
  assert.deepEqual(facts({ shopName: "a" }).candidates.map(c => c.id), ["akari", "trattoria-sole"]);
  assert.equal(facts({ shopName: "sole" }).shop.id, "trattoria-sole");
  assert.equal(facts({ shopName: "Robata Akari" }).shop.id, "akari");
  assert.equal(facts({ shopId: "akari" }).shop.id, "akari");
});

test("the MCP label lists only tools called in the current turn", async () => {
  const answers = [];
  const hybrid = { device: "not_prepared", policy: boundedPolicy(), emit: event => event.answer && answers.push(event.answer),
    generate: async () => ({ response: { text: () => "Done", candidates: [{ content: { parts: [{ type: "text", text: "Done" }] } }] },
      source: "IN_CLOUD", log: { task: "agent", source: "IN_CLOUD" } }) };
  const engine = { top: { llm: {} }, _compile: async () => ({ llm: {} }),
    trace: { spans: new Map([["front", { isTopFrontMan: true }]]), start() {}, end() {}, fail() {} } };
  installHybridEngine(engine, { hybrid }, { scope: "shop", getFacts: () => ({ id: "akari", name: "Robata Akari" }) });
  await engine.top.llm.chat({ parentSpan: "front", tools: [], messages: [
    { role: "user", content: "Check availability tomorrow at 19:00 for 2" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "check_availability", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "check_availability", content: "{}" },
    { role: "assistant", content: "Available." },
    { role: "user", content: "Thanks, what is the address?" },
  ] });
  assert.deepEqual(answers.at(-1).tools, []);
});
