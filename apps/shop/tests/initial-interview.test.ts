import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Models } from "@google/genai";
import { initialInterviewReply, type InitialInterviewContext } from "../server/initial-interview.ts";
import { explainSystem } from "../server/ai.ts";
import { sample } from "../server/domain.ts";
import { initialInterviewFacts, initialFeatureQuestion, requestIntentInstruction, restaurantFeatureQuestion, reservationChoiceQuestion, initialSetupDemoReply } from "../server/request-intent.ts";
import type { generateJson } from "../server/llm.ts";

type ModelInput = Parameters<typeof generateJson>[0];
const oldImage = {id: "a".repeat(64), name: "reference.png", mimeType: "image/png", data: "b2xk"};
const newImage = {...oldImage, id: "b".repeat(64), name: "logo.png", data: "bmV3"};
const messages: InitialInterviewContext["messages"] = [
  {role: "user", text: "店名は月のアトリエ。ロゴはなし。ネイルサロンです。"},
  {role: "assistant", text: "追加したい機能を選んでください。\n1. スタッフ紹介\n2. ブログ\n3. お知らせ\n4. 商品紹介"},
];
const reply = {answer: "それ以外に欲しいページはありますか？", changeRequest: true, ready: false};
const payload = (input: ModelInput) => JSON.parse(input.contents[0].parts![0].text!);

test("feature selection uses the actual options and freeform answers without eager image or history retrieval", async () => {
  const inputs: ModelInput[] = [];
  const history = mock.fn(async () => []);
  const images = mock.fn(async () => [oldImage]);
  const question = "1と3。スタッフ紹介は一人分だけ。背景はベージュに変えてください。";
  const facts = initialInterviewFacts([...messages, {role: "user", text: question}]);
  const result = await initialInterviewReply(`${requestIntentInstruction["create-shop"]}\n${question}`, {
    messages, facts, region: {country: "US", timeZone: "America/New_York"},
    availableImageIds: [oldImage.id], loadImages: images, searchHistory: history,
  }, async input => { inputs.push(input); return JSON.stringify(reply); });
  assert.deepEqual(result, reply);
  assert.equal(inputs.length, 1);
  assert.equal(images.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  const request = payload(inputs[0]);
  assert.equal(request.question, question);
  assert.deepEqual(request.messages, messages);
  assert.equal(request.facts.name, "月のアトリエ");
  assert.deepEqual(request.facts.articles, {blogs: false, announcements: true});
  assert.deepEqual(request.facts.introductions, {staff: true, products: false});
  assert.equal(request.region.currency, "USD");
  assert.deepEqual(request.attachments, [{id: oldImage.id, pixelsProvided: false}]);
  for (const key of ["config", "spec", "history", "relatedHistory"]) assert.equal(key in request, false);
  assert.equal(inputs[0].contents[0].parts!.length, 1);
  assert.match(inputs[0].system, /beginner with no programming knowledge/);
  assert.match(inputs[0].system, /Do not follow a fixed questionnaire/);
});

test("new attachments are visible immediately and earlier image pixels can be requested on demand", async () => {
  const inputs: ModelInput[] = [];
  const images = mock.fn(async (ids: string[]) => { assert.deepEqual(ids, [oldImage.id]); return [oldImage]; });
  const result = await initialInterviewReply("前の参考画像と今回のロゴの色を合わせたい", {
    messages, images: [newImage], availableImageIds: [oldImage.id, newImage.id], loadImages: images,
  }, async input => {
    inputs.push(input);
    return JSON.stringify(inputs.length === 1 ? {...reply, inspectImageIds: [oldImage.id]} : {...reply, ready: true});
  });
  assert.equal(images.mock.callCount(), 1);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0].contents[0].parts!.filter(part => part.inlineData).map(part => part.inlineData!.data), [newImage.data]);
  assert.deepEqual(inputs[1].contents[0].parts!.filter(part => part.inlineData).map(part => part.inlineData!.data), [newImage.data, oldImage.data]);
  assert.deepEqual(payload(inputs[1]).attachments.map((image: {pixelsProvided: boolean}) => image.pixelsProvided), [true, true]);
  assert.deepEqual(result, {...reply, ready: true});
});

test("interview cannot request an image outside its conversation", async () => {
  const images = mock.fn(async () => [oldImage]);
  await assert.rejects(initialInterviewReply("画像の色は？", {
    messages, availableImageIds: [newImage.id], loadImages: images,
  }, async () => JSON.stringify({...reply, inspectImageIds: [oldImage.id]})), {status: 404});
  assert.equal(images.mock.callCount(), 0);
});

test("missing earlier details can be searched without an unbounded model loop", async () => {
  const inputs: ModelInput[] = [];
  const history = mock.fn(async (query: string) => {
    assert.equal(query, "電話予約");
    return [{conversationId: "saved", requestId: "old", intent: "create-shop" as const, at: "2026-11-01T00:00:00Z", messages: [{role: "user" as const, text: "電話予約の案内も入れたい"}]}];
  });
  const result = await initialInterviewReply("前の案内も入れて", {messages, searchHistory: history}, async input => {
    inputs.push(input);
    // A repeated unresolved query must never start generation or loop forever.
    return JSON.stringify({...reply, ready: true, historyQuery: "電話予約"});
  });
  assert.equal(history.mock.callCount(), 1);
  assert.equal(inputs.length, 2);
  assert.match(JSON.stringify(payload(inputs[1]).relatedHistory), /電話予約の案内も入れたい/);
  assert.deepEqual(result, {...reply, ready: false});
});

test("the real initial interview entry point uses the chat model without sending provisional configuration", async t => {
  const keys = ["GOOGLE_CLOUD_PROJECT", "VERTEX_MODEL", "VERTEX_DESIGN_MODEL"];
  const old = keys.map(key => process.env[key]);
  process.env.GOOGLE_CLOUD_PROJECT = "fixture";
  process.env.VERTEX_MODEL = "chat-fixture";
  process.env.VERTEX_DESIGN_MODEL = "design-fixture";
  t.after(() => { mock.restoreAll(); keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }); });
  const calls: any[] = [];
  mock.method(Models.prototype as any, "generateContentInternal", async (input: any) => {
    calls.push(input); return {text: JSON.stringify(reply)};
  });
  await explainSystem("1と3", sample, false, {messages, history: [{at: "now", summary: "unpublished sample"}], initialSetup: true});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "chat-fixture");
  const request = JSON.parse(calls[0].contents[0].parts[0].text);
  assert.equal("config" in request, false);
  assert.equal("spec" in request, false);
  assert.equal("history" in request, false);
  assert.equal(JSON.stringify(request).includes(sample.menus[0]?.name), false);
});

const restaurantStart = [{ role: "user", text: "店名は灯。飲食店です。ロゴはなし。" }];

test("restaurant feature selection offers reservations with or without booking", () => {
  assert.equal(initialSetupDemoReply("店名は灯。飲食店です。ロゴはなし。", []).answer, restaurantFeatureQuestion);
  for (const [answer, enabled, articles] of [
    ["1と3", true, { blogs: true, announcements: false }],
    ["2と4", false, { blogs: false, announcements: true }],
    ["予約なし、ブログを追加", false, { blogs: true, announcements: false }],
    ["予約あり", true, { blogs: false, announcements: false }],
  ] as const) {
    const facts = initialInterviewFacts([...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: answer }]);
    assert.equal(facts.reservationsEnabled, enabled, answer);
    assert.deepEqual(facts.articles, articles, answer);
    assert.equal(facts.question, undefined, answer);
  }
  // Beside a list of features, a bare "なし" means no extra features: the reservation choice is still open and is asked on its own.
  const none = initialInterviewFacts([...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "なし" }]);
  assert.deepEqual([none.reservationsEnabled, none.articles, none.question], [undefined, { blogs: false, announcements: false }, reservationChoiceQuestion]);
  const asked = [...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "なし" }, { role: "assistant", text: reservationChoiceQuestion }];
  assert.equal(initialInterviewFacts([...asked, { role: "user", text: "いいえ" }]).reservationsEnabled, false);
  assert.equal(initialInterviewFacts([...asked, { role: "user", text: "はい" }]).reservationsEnabled, true);
});

test("an earlier reservation choice survives recaps, ambiguous picks and remarks about other ways to reserve", () => {
  const chosen = [...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "1と3" }];
  // A recap lists what was decided; it does not ask the reservation question again.
  const recap = { role: "assistant", text: "ここまでの内容です。\n1. 予約あり\n2. ブログ\n\nほかに伝えたいことはありますか？" };
  for (const answer of ["なし", "いいえ", "no"]) {
    const facts = initialInterviewFacts([...chosen, recap, { role: "user", text: answer }]);
    assert.equal(facts.reservationsEnabled, true, answer);
    assert.deepEqual(facts.articles, { blogs: true, announcements: false }, answer);
  }
  const declined = [...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "2" }, { role: "assistant", text: "1. 予約なし（店舗情報のみ）\n\nほかに伝えたいことはありますか？" }, { role: "user", text: "はい" }];
  assert.equal(initialInterviewFacts(declined).reservationsEnabled, false);
  // Picking both answers decides nothing new.
  assert.equal(initialInterviewFacts([...chosen, { role: "assistant", text: reservationChoiceQuestion }, { role: "user", text: "1, 2" }]).reservationsEnabled, true);
  for (const remark of ["電話予約はなしで、ネット予約だけにしたい", "紹介ページだけ先に作りたい", "当日予約は受け付けません", "No phone reservations, please"]) {
    assert.equal(initialInterviewFacts([...chosen, { role: "user", text: remark }]).reservationsEnabled, true, remark);
    assert.equal(initialInterviewFacts([...restaurantStart, { role: "user", text: remark }]).reservationsEnabled, undefined, remark);
  }
  for (const refusal of ["予約はなしで", "予約機能は不要です", "店舗情報のみでいいです", "紹介ページだけ", "no reservations"])
    assert.equal(initialInterviewFacts([...chosen, { role: "user", text: refusal }]).reservationsEnabled, false, refusal);
});

test("reservation choices use actual labels and preserve previous feature selections", () => {
  const conversation = [...restaurantStart, { role: "assistant", text: "機能を選んでください。\n1. お知らせ\n2. 予約なし\n3. ブログ\n4. 予約あり" }, { role: "user", text: "2と3" }];
  assert.equal(initialInterviewFacts(conversation).reservationsEnabled, false);
  const changed = initialInterviewFacts([...conversation, { role: "user", text: "やはり予約ありにしてください" }]);
  assert.equal(changed.reservationsEnabled, true);
  assert.deepEqual(changed.articles, { blogs: true, announcements: false });
  const undecided = [...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "3だけ" }];
  assert.equal(initialInterviewFacts(undecided).question, reservationChoiceQuestion);
  const answered = initialInterviewFacts([...undecided, { role: "assistant", text: reservationChoiceQuestion }, { role: "user", text: "2" }]);
  assert.equal(answered.reservationsEnabled, false);
  assert.deepEqual(answered.articles, { blogs: true, announcements: false });
  const conflict = initialInterviewFacts([...restaurantStart, { role: "assistant", text: restaurantFeatureQuestion }, { role: "user", text: "1と2" }]);
  assert.equal(conflict.reservationsEnabled, undefined);
  assert.equal(conflict.question, reservationChoiceQuestion);
  const english = initialInterviewFacts([...restaurantStart, { role: "assistant", text: "Choose features.\n1. Blog\n2. No reservations\n3. With reservations" }, { role: "user", text: "1 and 2" }]);
  assert.equal(english.reservationsEnabled, false);
  assert.equal(english.articles?.blogs, true);
});

test("invited shops of the other kind are asked whether to take reservations; salons are not", () => {
  const start = [{ role: "user", text: "店名は月の雑貨。ロゴはなし。" }, { role: "assistant", text: initialFeatureQuestion }, { role: "user", text: "ブログ" }];
  assert.equal(initialInterviewFacts(start, { industry: "other" }).question, reservationChoiceQuestion);
  assert.equal(initialInterviewFacts(start, { industry: "nail" }).question, undefined);
  assert.equal(initialInterviewFacts(start).question, undefined, "without an invitation, an unnamed industry is not assumed");
  const answered = [...start, { role: "assistant", text: reservationChoiceQuestion }, { role: "user", text: "2" }];
  const facts = initialInterviewFacts(answered, { industry: "other" });
  assert.equal(facts.reservationsEnabled, false);
  assert.equal(facts.question, undefined);
  // A restaurant named in the chat is still asked even when its draft started with the default industry.
  assert.equal(initialInterviewFacts([{ role: "user", text: "店名は灯。飲食店です。ロゴはなし。" }, { role: "assistant", text: initialFeatureQuestion }, { role: "user", text: "ブログ" }], { industry: "nail" }).question, reservationChoiceQuestion);
});
