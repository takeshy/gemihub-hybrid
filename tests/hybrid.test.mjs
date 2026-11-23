import test from "node:test";
import assert from "node:assert/strict";
import { InferenceMode, InferenceSource } from "firebase/ai";
import { HybridInference } from "../hybrid/firebase-client.js";
import { boundedPolicy, routePolicy, validateDecision, registryFacts } from "../hybrid/policy.js";
import { cloudRequest, runtimeResponse } from "../hybrid/messages.js";
import { installHybridEngine } from "../hybrid/browser.js";

test("tools, history, comparisons and transactional questions cannot be routed locally", () => {
  const policy = boundedPolicy({ localQuestionChars: 999999, localContextChars: 999999 });
  assert.equal(policy.localQuestionChars, 2000);
  assert.equal(policy.localContextChars, 16000);
  for (const value of [
    { question: "営業時間は？", hasTools: true },
    { question: "営業時間は？", historyCount: 1 },
    { question: "その店は何時から？" },
    { question: "2店を比較して" },
    { question: "この店を予約したい" },
    { question: "What is the total price?" },
    { question: "Is it safe for my allergy?" },
  ]) assert.equal(routePolicy({ task: "single_shop", ...value }, policy).local, false, JSON.stringify(value));
  assert.equal(routePolicy({ question: "炉端 灯の住所は？", task: "single_shop" }, policy).local, true);
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
