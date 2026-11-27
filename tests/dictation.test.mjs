import test from "node:test";
import assert from "node:assert/strict";
import { InferenceMode, InferenceSource } from "firebase/ai";
import { createDictation, endWord } from "../hybrid/dictation.js";
import { HybridInference } from "../hybrid/firebase-client.js";

const messages = { unsupported: "unsupported", denied: "denied", noSpeech: "no speech", failed: "failed" };
function fakeInput(value = "") {
  const input = { value, events: 0, dispatchEvent() { this.events++; } };
  return input;
}
function fakeRecognition() {
  const recognition = { started: false, start() { this.started = true; }, stop() { this.onend?.(); }, abort() { this.onend?.(); } };
  recognition.say = (...parts) => recognition.onresult({ results: parts.map(part => Object.assign([{ transcript: typeof part === "string" ? part : part.text }], { isFinal: typeof part !== "string" && !!part.final })) });
  return recognition;
}

test("dictation fills the input, then replaces it with the on-device tidy-up without sending", async () => {
  const input = fakeInput("Hello");
  const recognition = fakeRecognition();
  const states = [];
  let polished;
  const dictation = createDictation({ input, language: "en-US", messages, createRecognition: () => recognition, onState: state => states.push(state),
    polish: async text => { polished = text; return "I'd like a table on Friday."; } });
  dictation.toggle();
  assert.equal(recognition.lang, "en-US");
  assert.equal(recognition.continuous, true);
  recognition.say("um I'd like ", "a table on friday");
  assert.equal(input.value, "Hello um I'd like a table on friday");
  assert.ok(input.events > 0, "the chat runtime sees the new text");
  dictation.toggle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polished, "um I'd like a table on friday");
  assert.equal(input.value, "Hello I'd like a table on Friday.");
  assert.deepEqual(states.map(state => state.status), ["listening", "polishing", "idle"]);
});

test("the visitor's edits during the tidy-up win, and failures keep the dictated text", async () => {
  const input = fakeInput();
  const recognition = fakeRecognition();
  let release;
  const dictation = createDictation({ input, language: "ja-JP", messages, createRecognition: () => recognition, onState() {},
    polish: () => new Promise(resolve => { release = resolve; }) });
  dictation.toggle();
  recognition.say("金曜日に予約したい");
  dictation.toggle();
  input.value = "金曜日に2名で予約したい";
  release("金曜日に予約したいです。");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, "金曜日に2名で予約したい");

  const kept = fakeInput("営業時間は");
  const failing = createDictation({ input: kept, language: "ja-JP", messages, createRecognition: () => recognition, onState() {},
    polish: async () => { throw new Error("offline"); } });
  failing.toggle();
  recognition.say("何時までですか");
  failing.toggle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kept.value, "営業時間は何時までですか");
});

test("denied microphones report an error and sending cancels dictation without a tidy-up", async () => {
  const states = [];
  const recognition = fakeRecognition();
  const dictation = createDictation({ input: fakeInput(), language: "en-US", messages, createRecognition: () => recognition, onState: state => states.push(state),
    polish: async () => assert.fail("no tidy-up after an error") });
  dictation.toggle();
  recognition.onerror({ error: "not-allowed" });
  recognition.onend();
  assert.deepEqual(states.at(-1), { status: "idle", error: "denied" });

  let polishCalls = 0;
  const input = fakeInput();
  const other = fakeRecognition();
  const sent = createDictation({ input, language: "en-US", messages, createRecognition: () => other, onState() {}, polish: async () => { polishCalls++; return "x"; } });
  sent.toggle();
  other.say("what time do you open");
  sent.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polishCalls, 0);
  assert.equal(input.value, "what time do you open");
  assert.equal(sent.active, false);
});

test("Nano tidies dictation on the device only and never falls back to the cloud", async () => {
  const configurations = [];
  let source = InferenceSource.ON_DEVICE, reply = "What time do you open on Sunday?";
  const hybrid = new HybridInference({ cloudModel: "gemini-4-hydrogen" }, { ai: {}, now: () => 10,
    factory: (_ai, config) => { configurations.push(config); return { generateContent: async () => ({ response: { inferenceSource: source, text: () => reply } }) }; } });
  assert.equal(await hybrid.polishDictation("uh what time do you open on sunday"), null, "no device model, no tidy-up");
  assert.equal(configurations.length, 0);
  hybrid.device = "ready";
  assert.equal(await hybrid.polishDictation("uh what time do you open on sunday"), reply);
  assert.equal(configurations[0].mode, InferenceMode.ONLY_ON_DEVICE);
  assert.equal(hybrid.logs.at(-1).task, "dictation_polish");
  assert.equal(JSON.stringify(hybrid.logs).includes("sunday"), false, "logs keep no dictated text");
  source = InferenceSource.IN_CLOUD;
  assert.equal(await hybrid.polishDictation("uh what time"), null);
  source = InferenceSource.ON_DEVICE; reply = "x".repeat(500);
  assert.equal(await hybrid.polishDictation("short"), null, "a runaway rewrite is discarded");
});

test("edits made while listening stay, and only later speech is appended", () => {
  const input = fakeInput();
  const recognition = fakeRecognition();
  const dictation = createDictation({ input, language: "en-US", messages, createRecognition: () => recognition, onState() {} });
  dictation.toggle();
  recognition.say({ text: "book a table for four people", final: true });
  input.value = "book a table";
  recognition.say({ text: "book a table for four people", final: true }, "on friday");
  assert.equal(input.value, "book a table on friday", "the deleted words do not come back");
});

test("saying over at the end sends the tidied message; over inside a word does not", async () => {
  assert.deepEqual(endWord("what time do you open over", true), { spoken: "what time do you open", send: true });
  assert.deepEqual(endWord("営業時間を教えて以上。", true), { spoken: "営業時間を教えて", send: true });
  assert.equal(endWord("what about the leftover", true).send, false);
  assert.equal(endWord("open over", false).send, false, "interim results never send");
  const input = fakeInput();
  const recognition = fakeRecognition();
  const sent = [];
  const dictation = createDictation({ input, language: "en-US", messages, createRecognition: () => recognition, onState() {},
    polish: async text => text.replace("um ", "") + "?", send: () => sent.push(input.value) });
  dictation.toggle();
  recognition.say({ text: "um what time do you open over", final: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ["what time do you open?"]);
  assert.equal(dictation.active, false);
  // Stopping with the microphone never sends.
  const quiet = createDictation({ input: fakeInput(), language: "en-US", messages, createRecognition: () => fakeRecognition(), onState() {}, send: () => assert.fail("no send") });
  quiet.toggle(); quiet.toggle();
});
