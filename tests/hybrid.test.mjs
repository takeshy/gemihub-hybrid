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
  groundedPrompt,
} from "../hybrid/policy.js";
import { shopJsonLd, openingHoursSpecification, parseHoursText } from "../hybrid/schema-org.js";
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
    { question: "What is the total for the course?" },
    { question: "コース3人分の合計は？" },
    { question: "What kind of shop is this?", historyCount: 1 },
    { question: "What type of business was that shop?" },
    { question: "What kind of shop is this, and can I book?" },
    { question: "What kind of shop is this compared to the other shop?" },
  ]) assert.equal(routePolicy({ task: "single_shop", ...value }, policy).local, false, JSON.stringify(value));
  assert.equal(routePolicy({ question: "予約したい", task: "booking_preflight", historyCount: 1 }, policy).local, false);
  assert.equal(routePolicy({ question: "予約したい", task: "booking_preflight" }, policy).local, true);
  assert.equal(routePolicy({ question: "炉端 灯の住所は？", task: "single_shop" }, policy).local, true);
  assert.equal(routePolicy({ question: "コースのメニューを教えて", task: "single_shop" }, policy).local, true);
  for (const question of ["コース料金とメニューを教えて", "冬のコースはいくら？", "How much is the Winter robata course?", "What is the price of warm sake?"])
    assert.deepEqual(routePolicy({ question, task: "single_shop" }, policy), { local: true, reason: "published_shop_facts" }, question);
  assert.equal(routePolicy({ question: "ベジタリアン対応はある？", task: "single_shop" }, policy).local, true);
  assert.equal(routePolicy({ question: "What type of business is this?" }, policy).local, true);
  assert.equal(routePolicy({ question: "What kind of store is this?" }, policy).local, true);
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

function engineFixture(options) {
  const calls = [];
  const hybrid = { policy: boundedPolicy(), emit() {}, generate: async input => {
    calls.push(input);
    if (input.task === "decision") return { response: { text: () => '{"kind":"single_shop","shopIds":["akari"]}' } };
    return { response: { text: () => "Published answer", candidates: [{ content: { parts: [{ type: "text", text: "Cloud answer" }] } }] }, log: {}, source: "IN_CLOUD" };
  } };
  const engine = { top: { llm: {} }, _compile: async () => ({ llm: {} }),
    trace: { spans: new Map([["front", { isTopFrontMan: true }]]), start() {}, end() {}, fail() {} } };
  installHybridEngine(engine, { hybrid }, options ?? {
    getShops: () => [{ id: "akari", name: "Akari", address: "A street", owner: "secret" }, { id: "other", name: "Other shop" }],
  });
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

test("an English shop category question reaches the local FAQ path with the published category", async () => {
  const { engine, calls } = engineFixture({
    scope: "shop",
    getFacts: () => ({ name: "Zakka Mori", industry: "other", cuisine: "Home goods and stationery" }),
  });
  await engine.top.llm.chat({
    parentSpan: "front",
    messages: [{ role: "user", content: "What kind of shop is this?" }],
    tools: [],
  });
  assert.deepEqual(calls.map(call => call.task), ["single_shop"]);
  assert.match(calls[0].prompt, /"keywords":"Home goods and stationery"/);
});

test("invalid classification cannot invent a local shop context", async () => {
  const { engine, hybrid, calls } = engineFixture();
  const generate = hybrid.generate;
  hybrid.generate = async input => input.task === "decision"
    ? { response: { text: () => '{"kind":"single_shop","shopIds":["not-registered"]}' } } : generate(input);
  await engine.top.llm.chat({ parentSpan: "front", messages: [{ role: "user", content: "Where is the nearby restaurant?" }], tools: [] });
  assert.equal(calls.length, 1); assert.equal(calls[0].task, "agent");
});

test("the town guide previews only verified on-device FAQ chunks", async () => {
  const { engine, hybrid } = engineFixture();
  const events = [];
  const received = [];
  hybrid.emit = event => events.push(event);
  hybrid.generate = async ({ onDelta }) => {
    onDelta("Hours: ", InferenceSource.ON_DEVICE);
    onDelta("unconfirmed source");
    onDelta("cloud text", InferenceSource.IN_CLOUD);
    return { response: { text: () => "Hours: 17:00." }, log: {}, source: "ON_DEVICE", streamed: true };
  };
  await engine.top.llm.chat({
    parentSpan: "front",
    messages: [{ role: "user", content: "What are Akari's opening hours?" }],
    tools: [],
    onContentDelta: delta => received.push(delta),
  });
  assert.deepEqual(events.filter(event => event.faqDelta), [{ faqDelta: "Hours: " }]);
  assert.deepEqual(received, ["Hours: ", "unconfirmed source", "cloud text"]);
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
          yield { text: () => "Open ", inferenceSource: InferenceSource.ON_DEVICE };
          yield { text: () => "17:00-23:30.", inferenceSource: InferenceSource.ON_DEVICE };
        })(),
        response: Promise.resolve({ inferenceSource: InferenceSource.ON_DEVICE, text: () => "Open 17:00-23:30." }),
      }),
    }) });
  hybrid.device = "ready";
  const result = await hybrid.generate({
    task: "single_shop",
    question: "What are the hours?",
    prompt: "Published facts",
    onDelta: (delta, source) => chunks.push([delta, source]),
  });
  assert.equal(result.streamed, true);
  assert.equal(result.source, "ON_DEVICE");
  assert.deepEqual(chunks, [["Open ", InferenceSource.ON_DEVICE], ["17:00-23:30.", InferenceSource.ON_DEVICE]]);
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

test("a ready device keeps one idle Nano session warm and logs first-token latency", async () => {
  const originalLM = globalThis.LanguageModel;
  try {
    let created = 0;
    globalThis.LanguageModel = { availability: async () => "available", create: async () => { created += 1; return {}; } };
    let clock = 0;
    const hybrid = new HybridInference({}, { ai: {}, now: () => (clock += 100),
      factory: () => ({ generateContentStream: async () => ({
        stream: (async function* () { yield { text: () => "Open" }; yield { text: () => " 17:00." }; })(),
        response: Promise.resolve({ inferenceSource: InferenceSource.ON_DEVICE, text: () => "Open 17:00." }),
      }) }) });
    await hybrid.probeAvailability();
    await hybrid.warming;
    await hybrid.warmDevice();
    assert.equal(created, 1);
    const result = await hybrid.generate({ task: "single_shop", question: "What are the hours?", prompt: "Facts", onDelta() {} });
    assert.equal(result.log.firstTokenMs, 100);
    assert.ok(result.log.durationMs > result.log.firstTokenMs);
  } finally {
    globalThis.LanguageModel = originalLM;
  }
});

test("published facts become schema.org Restaurant JSON-LD without prices or private fields", () => {
  const ld = shopJsonLd({ id: "akari", name: "Robata Akari", industry: "restaurant", cuisine: "Japanese robata", area: "Nakazakicho, Osaka",
    address: "Published address", hours: "17:00 – 23:30", pageUrl: "https://example.test/s/akari/",
    reservationEnabled: true, reservationUrl: "https://example.test/s/akari/reserve",
    products: ["Winter robata course", { name: "Warm sake", price: 600, currency: "JPY" }, "Winter robata course"],
    owner: "private", bookings: ["private"] });
  assert.equal(ld["@context"], "https://schema.org");
  assert.equal(ld["@type"], "Restaurant");
  assert.equal(ld.servesCuisine, "Japanese robata");
  assert.deepEqual(ld.openingHoursSpecification, [{ "@type": "OpeningHoursSpecification",
    dayOfWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "17:00", closes: "23:30" }]);
  assert.deepEqual(ld.hasMenu.hasMenuItem.map(item => item.name), ["Winter robata course", "Warm sake"]);
  assert.equal(ld.acceptsReservations, "https://example.test/s/akari/reserve");
  assert.doesNotMatch(JSON.stringify(ld), /private|price|600|JPY/);
  assert.equal(shopJsonLd({ name: "Salon", industry: "hair", products: [{ name: "Cut" }] }).makesOffer[0].itemOffered["@type"], "Service");
  assert.equal(shopJsonLd({ description: "no name" }), null);
  const priced = shopJsonLd({ name: "Robata Akari", industry: "restaurant", products: [
    { name: "Warm sake", price: 600, currency: "JPY" }, { name: "Unpriced", currency: "JPY" }, { name: "Bad currency", price: 1, currency: "yen" },
    { name: "Gift box", type: "Product", price: 1200, currency: "JPY" }] }, { prices: true });
  assert.deepEqual(priced.hasMenu.hasMenuItem, [
    { "@type": "MenuItem", name: "Warm sake", offers: { "@type": "Offer", price: 600, priceCurrency: "JPY" } },
    { "@type": "MenuItem", name: "Unpriced" }, { "@type": "MenuItem", name: "Bad currency" }]);
  assert.deepEqual(priced.makesOffer, [{ "@type": "Offer", price: 1200, priceCurrency: "JPY", itemOffered: { "@type": "Product", name: "Gift box" } }]);
  const pricePrompt = groundedPrompt("How much is warm sake?", registryFacts({ name: "Robata Akari", industry: "restaurant",
    products: [{ name: "Warm sake", type: "MenuItem", price: 600, currency: "JPY", private: "x" }] }));
  assert.match(pricePrompt, /"name":"Warm sake","offers":\{"@type":"Offer","price":600,"priceCurrency":"JPY"\}/, "Nano can quote the listed price");
  assert.match(pricePrompt, /never calculate a total/);
});

test("opening hours keep weekday overrides, closures and special days; unknown text stays as text", () => {
  assert.deepEqual(parseHoursText("17:00 – 23:30 / 月曜 17:00 – 22:00").weekdayHours, [{ day: 1, start: "17:00", end: "22:00" }]);
  assert.deepEqual(parseHoursText("18:00 – 23:00 / Mon 18:00 – 21:00").weekdayHours, [{ day: 1, start: "18:00", end: "21:00" }]);
  assert.deepEqual(parseHoursText("9:00 – 24:00"), { start: "09:00", end: "24:00", weekdayHours: [] });
  for (const invalid of ["17:00 – 24:30", "17:00 – 23:60", "25:00 – 26:00"]) assert.equal(parseHoursText(invalid), null);
  const { weekly, exceptions, parsed } = openingHoursSpecification({ regular: "17:00 – 23:30 / Mon 17:00 – 22:00",
    closedWeekdays: ["Tuesday", 3], weekdayHours: [{ day: 5, start: "9:00", end: "17:00" }],
    closedDates: ["2030-12-31", "not-a-date"], specialDays: "2030-12-30 10:00 – 15:00（出勤：Aki） / bad" });
  assert.equal(parsed, true);
  assert.deepEqual(weekly.map(spec => [spec.dayOfWeek, spec.opens, spec.closes]), [
    [["Sunday", "Thursday", "Saturday"], "17:00", "23:30"],
    ["Monday", "17:00", "22:00"],
    ["Friday", "09:00", "17:00"],
    [["Tuesday", "Wednesday"], "00:00", "00:00"],
  ]);
  assert.deepEqual(exceptions.map(spec => [spec.validFrom, spec.opens, spec.closes]), [
    ["2030-12-31", "00:00", "00:00"],
    ["2030-12-30", "10:00", "15:00"],
  ]);
  assert.deepEqual(openingHoursSpecification({ regular: "17:00 – 23:30", specialDays: [{ date: "2030-01-02", start: "11:00", end: "14:00", staffIds: ["x"] }] }).exceptions[0],
    { "@type": "OpeningHoursSpecification", validFrom: "2030-01-02", validThrough: "2030-01-02", opens: "11:00", closes: "14:00" });
  assert.equal(parseHoursText("Evenings, ask the shop"), null);
  const unparsed = shopJsonLd({ name: "A", hours: { regular: "Evenings, ask the shop", closedWeekdays: [2], closedDates: ["2030-12-31"] } });
  assert.equal(unparsed.openingHours, "Evenings, ask the shop");
  assert.deepEqual(unparsed.openingHoursSpecification.map(spec => spec.dayOfWeek), ["Tuesday"]);
  assert.deepEqual(unparsed.specialOpeningHoursSpecification.map(spec => spec.validFrom), ["2030-12-31"]);
});

test("the on-device prompt carries the facts as JSON-LD and the question as data", () => {
  const prompt = groundedPrompt("What time do you open?", registryFacts({ id: "akari", name: "Robata Akari", industry: "restaurant", cuisine: "Japanese robata", hours: "17:00 – 23:30" }));
  assert.match(prompt, /schema\.org JSON-LD/);
  assert.match(prompt, /"@type":"Restaurant"/);
  assert.match(prompt, /"opens":"17:00","closes":"23:30"/);
  const special = groundedPrompt("Are you open on Dec 30?", { name: "Robata Akari", industry: "restaurant",
    hours: { regular: "17:00 – 23:30", closedWeekdays: ["Monday"], specialDays: "2030-12-30 10:00 – 15:00" } });
  assert.match(special, /"validFrom":"2030-12-30","validThrough":"2030-12-30","opens":"10:00","closes":"15:00"/);
  assert.match(special, /"dayOfWeek":"Monday","opens":"00:00","closes":"00:00"/);
  assert.doesNotMatch(prompt, /@context/);
  assert.match(prompt, /"What time do you open\?"/);
});

test("FAQ grounding retains all published names and exceptions before applying the prompt size limit", () => {
  const products = Array.from({ length: 50 }, (_, i) => `Dish ${i + 1}`);
  products.push(...Array.from({ length: 50 }, (_, i) => ({ name: `Catalog ${i + 1}`, type: "Product", price: 500 })));
  const facts = registryFacts({ name: "Akari", industry: "restaurant", products });
  const menuQuestion = "What is on the menu?";
  const menuPrompt = groundedPrompt(menuQuestion, facts);
  assert.match(menuPrompt, /"name":"Dish 50"/);
  assert.match(menuPrompt, /"@type":"Product","name":"Catalog 50"/);
  assert.doesNotMatch(menuPrompt, /"price"/, "items without a currency carry no price");
  assert.equal(routePolicy({ question: menuQuestion, contextChars: menuPrompt.length }).local, true);

  const dates = (month) => Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2030, month, i + 1)).toISOString().slice(0, 10));
  const closedDates = dates(0);
  const specialDays = dates(3).map(date => ({ date, start: "11:00", end: "14:00", staffIds: ["private"] }));
  const hours = { regular: "17:00 – 23:30", closedDates, specialDays };
  const hoursFacts = registryFacts({ name: "Akari", hours });
  const ld = shopJsonLd(hoursFacts);
  assert.equal(ld.specialOpeningHoursSpecification.length, 122);
  const hoursQuestion = "What are the hours?";
  const hoursPrompt = groundedPrompt(hoursQuestion, hoursFacts);
  assert.match(hoursPrompt, /"validFrom":"2030-01-01","validThrough":"2030-01-01","opens":"00:00"/);
  assert.match(hoursPrompt, /"validFrom":"2030-04-01","validThrough":"2030-04-01","opens":"11:00"/);
  assert.doesNotMatch(hoursPrompt, /private"/);
  assert.deepEqual(routePolicy({ question: hoursQuestion, contextChars: hoursPrompt.length }), { local: false, reason: "context_length" });
});

test("query_shop_facts also returns the shop as schema.org JSON-LD", () => {
  const data = { documents: [], shops: [
    { id: "akari", name: "Robata Akari", industry: "restaurant", cuisine: "Japanese robata", hours: "17:00 - 23:30", products: ["Winter robata course"],
      menu: [{ name: "Winter robata course", type: "MenuItem", price: 5000, currency: "JPY" }] },
    { id: "salon", name: "Local Salon", industry: "hair", cuisine: "Hair salon" },
    { id: "shop", name: "Local Shop", cuisine: "Shop" },
  ] };
  const query = shopId => handleTownMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "query_shop_facts", arguments: { shopId } } }, data).body.result.structuredContent;
  const result = query("akari");
  assert.equal(result.shop.id, "akari");
  assert.equal(result.jsonLd["@type"], "Restaurant");
  assert.deepEqual(result.jsonLd.hasMenu.hasMenuItem[0], { "@type": "MenuItem", name: "Winter robata course",
    offers: { "@type": "Offer", price: 5000, priceCurrency: "JPY" } });
  assert.equal(result.shop.menu, undefined, "tool results keep products as names");
  assert.deepEqual(result.shop.products, ["Winter robata course"]);
  const listed = handleTownMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_town_shops", arguments: {} } }, data);
  assert.ok(listed.body.result.structuredContent.shops.every(shop => !("menu" in shop)));
  assert.equal(query("salon").jsonLd["@type"], "HairSalon");
  assert.equal(query("salon").jsonLd.servesCuisine, undefined);
  assert.equal(query("shop").jsonLd["@type"], "LocalBusiness");
  assert.equal(query("shop").jsonLd.servesCuisine, undefined);
  assert.equal(query("salon").jsonLd.keywords, "Hair salon", "a non-restaurant keeps its category as a keyword");
  assert.equal(query("shop").jsonLd.keywords, "Shop");
  assert.equal(result.jsonLd.keywords, undefined, "a restaurant's category is its cuisine");
  assert.match(groundedPrompt("What kind of shop is this?", registryFacts({ name: "Zakka Mori", cuisine: "雑貨・生活雑貨" })), /"keywords":"雑貨・生活雑貨"/);
});
