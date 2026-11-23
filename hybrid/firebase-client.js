import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, ThinkingLevel } from "firebase/ai";
import { getRemoteConfig, fetchAndActivate, getAll, isSupported } from "firebase/remote-config";
import { DEFAULT_POLICY, boundedPolicy, routePolicy } from "./policy.js";
import { firebaseSchema } from "./messages.js";

export class HybridInference {
  constructor(config, { ai, factory = getGenerativeModel, now = () => performance.now() } = {}) {
    this.config = config; this.policy = boundedPolicy({ cloudModel: config.cloudModel });
    this.factory = factory; this.now = now; this.models = new Map(); this.logs = [];
    this.listeners = new Set(); this.device = "not_prepared";
    if (ai) { this.ai = ai; return; }
    if (!config.firebase?.appId || !config.firebase?.projectId?.startsWith("gemihub-hybrid-"))
      throw new Error("Configure this clone's dedicated Firebase project.");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    // Only localhost can opt into the debug provider. Never embed a token in builds.
    if (!config.appCheckSiteKey && !(local && globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN))
      throw new Error("Firebase App Check is not configured. The site operator must finish setup.");
    this.app = initializeApp(config.firebase, "gemihub-hybrid");
    initializeAppCheck(this.app, { provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey || "localhost-debug"), isTokenAutoRefreshEnabled: true });
    this.ai = getAI(this.app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });
    void this.loadPolicy();
  }
  async loadPolicy() {
    try {
      if (!await isSupported()) return;
      const remote = getRemoteConfig(this.app);
      remote.defaultConfig = { hybrid_local_question_chars: DEFAULT_POLICY.localQuestionChars,
        hybrid_local_context_chars: DEFAULT_POLICY.localContextChars,
        hybrid_max_output_tokens: DEFAULT_POLICY.maxOutputTokens,
        hybrid_cloud_model: this.config.cloudModel || DEFAULT_POLICY.cloudModel, hybrid_enabled: true };
      remote.settings.fetchTimeoutMillis = 3000;
      remote.settings.minimumFetchIntervalMillis = 3600000;
      const apply = () => {
        const values = getAll(remote);
        this.policy = boundedPolicy({
          localQuestionChars: values.hybrid_local_question_chars?.asNumber(),
          localContextChars: values.hybrid_local_context_chars?.asNumber(),
          maxOutputTokens: values.hybrid_max_output_tokens?.asNumber(),
          cloudModel: values.hybrid_cloud_model?.asString(), enabled: values.hybrid_enabled?.asBoolean(),
        });
      };
      apply(); // defaults/cache first; fetching never holds the chat UI.
      await fetchAndActivate(remote); apply();
    } catch { /* The bundled defaults work without Remote Config connectivity. */ }
  }
  model(mode, schema, systemInstruction) {
    const key = JSON.stringify([mode, schema, systemInstruction, this.policy.cloudModel, this.policy.maxOutputTokens]);
    if (!this.models.has(key)) {
      this.models.set(key, this.factory(this.ai, { mode,
        onDeviceParams: { createOptions: { expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
          expectedOutputs: [{ type: "text", languages: ["en", "ja"] }] },
          ...(schema ? { promptOptions: { responseConstraint: schema } } : {}) },
        inCloudParams: { model: this.policy.cloudModel, ...(systemInstruction ? { systemInstruction } : {}),
          generationConfig: { maxOutputTokens: this.policy.maxOutputTokens,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            ...(schema ? { responseMimeType: "application/json", responseSchema: firebaseSchema(schema) } : {}) } },
      }, { timeout: 45000 }));
      while (this.models.size > 12) this.models.delete(this.models.keys().next().value);
    }
    return this.models.get(key);
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  emit(event) { for (const callback of this.listeners) { try { callback(event); } catch { /* Diagnostics cannot break chat. */ } } }
  prepareDevice() {
    if (this.preparing) return this.preparing;
    // Called synchronously from a click/submit handler, never page load.
    const model = this.model(InferenceMode.PREFER_ON_DEVICE);
    this.device = "preparing"; this.emit({ device: this.device });
    this.preparing = model.initializeDeviceModel(progress => this.emit({ device: "downloading", progress }))
      .then(async () => {
        const available = await globalThis.LanguageModel?.availability({ expectedInputs: [{ type: "text", languages: ["en", "ja"] }], expectedOutputs: [{ type: "text", languages: ["en", "ja"] }] });
        this.device = available === "available" ? "ready" : "unavailable";
        this.emit({ device: this.device });
      }).catch(() => { this.device = "unavailable"; this.emit({ device: this.device }); })
      .finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async generate({ task, question, prompt, request, schema, systemInstruction, historyCount = 0,
    contextChars = 0, hasTools = false, crossShop = false, signal, finalAnswer = false }) {
    signal?.throwIfAborted();
    const size = JSON.stringify(request || prompt || "").length;
    if (size > this.policy.maxRequestChars) throw new Error("This conversation is too long. Start a new conversation.");
    const route = routePolicy({ question, contextChars, historyCount, hasTools, crossShop, task }, this.policy);
    // Do not wait for Chrome's availability/download work on the chat path.
    // Once preparation is complete the SDK chooses local vs cloud itself.
    const deviceAtStart = this.device;
    const mode = route.local && deviceAtStart === "ready" ? InferenceMode.PREFER_ON_DEVICE : InferenceMode.ONLY_IN_CLOUD;
    const started = this.now();
    let response;
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException("Inference timed out. Please try again.", "TimeoutError")), task === "decision" ? 8000 : 45000);
    let onAbort;
    try {
      const result = await Promise.race([
        this.model(mode, schema, systemInstruction).generateContent(request || prompt, { signal: requestSignal }),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(requestSignal.reason);
          requestSignal.addEventListener("abort", onAbort, { once: true });
          if (requestSignal.aborted) onAbort();
        }),
      ]);
      signal?.throwIfAborted(); response = result.response;
      const source = response.inferenceSource === InferenceSource.ON_DEVICE ? "ON_DEVICE"
        : response.inferenceSource === InferenceSource.IN_CLOUD ? "IN_CLOUD" : "UNKNOWN";
      const log = Object.freeze({ task, requestedMode: mode, source, durationMs: Math.round(this.now() - started),
        reason: route.local && mode === InferenceMode.ONLY_IN_CLOUD ? `device_${deviceAtStart}` : route.reason,
        fallback: route.local && source === "IN_CLOUD",
        fallbackReason: route.local && source === "IN_CLOUD" ? mode === InferenceMode.ONLY_IN_CLOUD ? deviceAtStart : "unknown" : null,
        finishReason: response.candidates?.[0]?.finishReason || null,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        thinkingTokens: response.usageMetadata?.thoughtsTokenCount || 0,
        finalAnswer, at: new Date().toISOString() });
      this.record(log); return { response, source, log };
    } catch (error) {
      this.record({ task, requestedMode: mode, source: "UNKNOWN", durationMs: Math.round(this.now() - started),
        reason: route.reason, error: signal?.aborted ? "aborted" : "inference_failed", finalAnswer: false });
      if (signal?.aborted) throw error;
      const english = globalThis.document?.documentElement?.lang === "en";
      throw new Error(english ? "AI could not answer. Please try again in a moment."
        : "AIの返答を確認できませんでした。少し時間をおいて再試行してください。", { cause: error });
    } finally { clearTimeout(timeout); if (onAbort) requestSignal.removeEventListener("abort", onAbort); }
  }
  record(log) { this.logs.push(log); if (this.logs.length > 100) this.logs.shift(); this.emit({ log }); }
}
