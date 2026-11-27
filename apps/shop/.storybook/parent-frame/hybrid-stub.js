// Storybook-only replacement for site/ai-connection.js. The real hybrid controls and routing run,
// but no Firebase project is contacted: cloud answers are fixed, and on-device calls use this
// browser's own Gemini Nano when Chrome provides it (otherwise they are answered as cloud).
import { HybridInference, installHybridEngine, mountHybridControls, readPublishedFacts } from "../parent-site/hybrid.bundle.js";

export { installHybridEngine, readPublishedFacts };
export const mountAiConnection = mountHybridControls;

const ON_DEVICE = "on_device", IN_CLOUD = "in_cloud";
const io = { expectedInputs: [{ type: "text", languages: ["en", "ja"] }], expectedOutputs: [{ type: "text", languages: ["en", "ja"] }] };
const english = () => document.documentElement.lang === "en";
const cloudAnswer = () => english()
  ? "This is a fixed Storybook answer. No cloud AI is contacted."
  : "Storybookの固定の返答です。クラウドのAIには接続していません。";

function response(text, source) {
  return { text: () => text, inferenceSource: source, candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { candidatesTokenCount: text.length } };
}
const promptText = request => typeof request === "string" ? request
  : (request?.contents || []).flatMap(content => content.parts || []).map(part => part.text || "").join("\n");

function model({ mode, onDeviceParams }) {
  const local = mode !== "only_in_cloud" && !!globalThis.LanguageModel;
  async function nano(request, signal) {
    const session = await globalThis.LanguageModel.create({ ...io, signal });
    try { return await session.prompt(promptText(request), { signal, ...(onDeviceParams?.promptOptions || {}) }); }
    finally { session.destroy?.(); }
  }
  async function answer(request, signal) {
    if (local && await globalThis.LanguageModel.availability(io) === "available") return response(await nano(request, signal), ON_DEVICE);
    if (mode === "only_on_device") throw new Error("Gemini Nano is not available in this browser.");
    return response(cloudAnswer(), IN_CLOUD);
  }
  return {
    async generateContent(request, { signal } = {}) { return { response: await answer(request, signal) }; },
    async generateContentStream(request, { signal } = {}) {
      const result = await answer(request, signal);
      return { stream: (async function* () { yield result; })(), response: Promise.resolve(result) };
    },
    async initializeDeviceModel(progress) {
      if (!globalThis.LanguageModel) return;
      const session = await globalThis.LanguageModel.create({ ...io, monitor(m) { m.addEventListener("downloadprogress", event => progress(event.loaded)); } });
      session.destroy?.();
    },
  };
}

export async function aiConnection() {
  const config = await (await fetch(new URL("../parent-site/hybrid-config.json", import.meta.url))).json();
  const hybrid = new HybridInference(config, { ai: {}, factory: (_ai, options) => model(options) });
  void hybrid.probeAvailability();
  return { mode: "hybrid", hybrid, config: { ...config, voice: false },
    setup: { router: new URL("/api/hybrid", location.origin).href, byokKey: "firebase-session", model: hybrid.policy.cloudModel } };
}
