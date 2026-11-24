import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import type { LiveConnectParameters, LiveServerMessage, Session } from "@google/genai";
import { publicAi, memoryAiState } from "../server/public-ai.ts";
import { createPublicLiveUpgrade } from "../server/public-live.ts";

test("public voice authenticates the site session, fixes model/tools, relays PCM/results and cleans up", { timeout: 10000 }, async t => {
  let base = "", parameters: LiveConnectParameters | undefined, ended = 0;
  const sessions = new EventEmitter();
  const audio: unknown[] = [], replies: any[] = [];
  const env = { GEMINI_API_KEY: "server-voice-secret", SESSION_SECRET: "fixture-secret", PUBLIC_AI_LIVE_MODEL: "fixture-live-model" };
  const gateway = publicAi({ env, state: memoryAiState() });
  const server = createServer((req, res) => { void gateway.handle(req, res, [base]); });
  server.on("upgrade", createPublicLiveUpgrade({ env, authorize: gateway.authorizeLive, allowedOrigins: async () => [base], connector: async value => {
    parameters = value;
    return { sendRealtimeInput(input: unknown) { audio.push(input); }, sendToolResponse(input: unknown) { replies.push(input); }, close() { sessions.emit("ended", ++ended); } } as unknown as Session;
  } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const session = await (await fetch(base + "/api/ai/session", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" })).json();
  const open = async (from = base) => { const ws = new WebSocket(base.replace("http:", "ws:") + "/api/ai/live", { headers: { Origin: from } }); sockets.push(ws); await once(ws, "open"); return ws; };
  const ws = await open();
  const message = () => once(ws, "message").then(([data]) => JSON.parse(String(data)));
  let next = message(); ws.send(JSON.stringify({ type: "start", token: session.token, language: "en" }));
  assert.equal((await next).type, "ready");
  const lease = await gateway.authorizeLive({ headers: { origin: base }, socket: { remoteAddress: "extra-client" } } as any, session.token, [base]);
  await assert.rejects(gateway.authorizeLive({ headers: { origin: base }, socket: { remoteAddress: "third-client" } } as any, session.token, [base]), { status: 429, code: "voice_busy" });
  lease(); lease();
  assert.equal(parameters!.model, "fixture-live-model");
  assert.ok(String(parameters!.config!.systemInstruction).includes("UI locale en"));
  assert.ok(!JSON.stringify(parameters).includes(env.GEMINI_API_KEY));
  assert.deepEqual((parameters!.config!.tools![0] as any).functionDeclarations.map((tool: any) => tool.name), ["consult", "ask_guide"]);
  const deliver = (value: Partial<LiveServerMessage>) => parameters!.callbacks!.onmessage!(value as LiveServerMessage);
  ws.send(JSON.stringify({ type: "audio", data: "AAAAAA==" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(audio, [{ audio: { data: "AAAAAA==", mimeType: "audio/pcm;rate=16000" } }]);
  next = message();
  deliver({ toolCall: { functionCalls: [{ id: "provider-id", name: "consult", args: { question: "図書館は何時に開きますか" } }] } });
  const call = await next;
  assert.equal(call.type, "consult"); assert.equal(call.guide, false);
  ws.send(JSON.stringify({ type: "result", id: "forged-id", answer: "invented", target: "guide" }));
  ws.send(JSON.stringify({ type: "result", id: call.id, answer: "9時です。資料: 図書館案内", target: "地域の案内" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies.length, 1); assert.equal(replies[0].functionResponses[0].id, "provider-id");
  assert.equal(replies[0].functionResponses[0].response.answer, "9時です。資料: 図書館案内");
  next = message(); deliver({ toolCall: { functionCalls: [{ id: "cancelled", name: "ask_guide", args: { question: "別の店と話したい" } }] } });
  const switching = await next; assert.equal(switching.guide, true);
  next = message(); deliver({ toolCallCancellation: { ids: ["cancelled"] } });
  assert.deepEqual(await next, { type: "cancel", id: switching.id });
  const closed = Promise.all([once(ws, "close"), once(sessions, "ended")]); ws.close(); await closed;
  assert.equal(ended, 1);
  const shopSocket=await open();
  const shopMessage=()=>once(shopSocket,"message").then(([data])=>JSON.parse(String(data)));
  next=shopMessage(); shopSocket.send(JSON.stringify({type:"start",token:session.token,language:"ja",scope:"shop"}));
  assert.equal((await next).type,"ready");
  assert.deepEqual((parameters!.config!.tools![0] as any).functionDeclarations.map((tool:any)=>tool.name),["consult"]);
  assert.match(String(parameters!.config!.systemInstruction),/current shop/);
  const repliesBefore=replies.length;
  deliver({toolCall:{functionCalls:[{id:"wrong-scope",name:"ask_guide",args:{question:"switch shops"}}]}});
  assert.equal(replies.length,repliesBefore+1);
  assert.ok(replies.at(-1).functionResponses[0].response.error);
  next=shopMessage();deliver({toolCall:{functionCalls:[{id:"shop-question",name:"consult",args:{question:"What does this shop sell?"}}]}});
  assert.equal((await next).guide,false);
  const shopClosed = Promise.all([once(shopSocket, "close"), once(sessions, "ended")]); shopSocket.close(); await shopClosed;
  assert.equal(ended,2);
  const invalid = await open();
  const refused = once(invalid, "close"); invalid.send(JSON.stringify({ type: "start", token: "forged", language: "ja" }));
  assert.equal((await refused)[0], 1008);
  const oversized = await open();
  const tooLarge = once(oversized, "close"); oversized.send("x".repeat(70000));
  assert.ok([1006, 1009].includes((await tooLarge)[0]));
  const foreign = new WebSocket(base.replace("http:", "ws:") + "/api/ai/live", { headers: { Origin: "https://evil.example" } }); sockets.push(foreign);
  await once(foreign, "error");
  // An allowed Origin sent to a host this relay does not serve is refused too.
  const otherHost = new WebSocket(base.replace("http:", "ws:") + "/api/ai/live", { headers: { Origin: base, Host: "other.example" } }); sockets.push(otherHost);
  await once(otherHost, "error");
});

test("voice admission shares persistent quotas, caps concurrent sessions and releases once", async () => {
  const gateway = publicAi({ env: { GEMINI_API_KEY: "fixture", PUBLIC_AI_LIVE_IP_DAILY_LIMIT: "1" }, state: memoryAiState() });
  let token = "";
  const base = "https://guide.example";
  const server = createServer((req, res) => { void gateway.handle(req, res, [base]); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    token = (await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/ai/session`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" })).json()).token;
    const req = { headers: { origin: base }, socket: { remoteAddress: "same-client" } } as any;
    const release = await gateway.authorizeLive(req, token, [base]); release(); release();
    await assert.rejects(gateway.authorizeLive(req, token, [base]), { status: 429, code: "voice_limit" });
    await assert.rejects(gateway.authorizeLive({ ...req, headers: { origin: "https://evil.example" } }, token, [base]), { status: 403 });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("voice admission sends a safe reason before closing and never connects a rejected session", async t => {
  let base = "", code = "voice_limit", connects = 0;
  const server = createServer((_req, res) => res.end());
  server.on("upgrade", createPublicLiveUpgrade({
    allowedOrigins: () => [base],
    authorize: async () => { throw Object.assign(new Error("must-not-leak-provider-credentials"), { status: 429, code }); },
    connector: async () => { connects++; throw new Error("must not connect"); },
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  for (code of ["voice_limit", "voice_busy"]) {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/api/ai/live", { headers: { Origin: base } });
    await once(ws, "open");
    const next = once(ws, "message"), closed = once(ws, "close");
    ws.send(JSON.stringify({ type: "start", token: "fixture-token", language: "ja" }));
    const [raw] = await next;
    assert.deepEqual(JSON.parse(String(raw)), { type: "error", code });
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(connects, 0);
});
