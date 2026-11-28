import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, ThinkingLevel } from "firebase/ai";
import { getRemoteConfig, fetchAndActivate, getAll, isSupported } from "firebase/remote-config";
import { DEFAULT_POLICY, boundedPolicy, routePolicy } from "./policy.js";
import { firebaseSchema } from "./messages.js";

const ON_DEVICE_IO = Object.freeze({
  expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
  expectedOutputs: [{ type: "text", languages: ["en", "ja"] }],
});

export class HybridInference {
  constructor(config, { ai, factory = getGenerativeModel, now = () => performance.now(), requireDevice = true } = {}) {
    this.config = config; this.policy = boundedPolicy({ cloudModel: config.cloudModel });
    this.factory = factory; this.now = now; this.models = new Map(); this.logs = [];
    this.listeners = new Set(); this.device = "not_prepared"; this.requireDevice = requireDevice;
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
    void this.probeAvailability();
  }
  async probeAvailability() {
    let status;
    try { status = await globalThis.LanguageModel?.availability(ON_DEVICE_IO); }
    catch { /* Leave an explicit setup attempt available. */ }
    if (this.device !== "not_prepared") return;
    if (status === "available") await this.prepareDevice();
    else if (!globalThis.LanguageModel?.create || status === "unavailable") this.setDevice("unsupported");
  }
  setDevice(device, progress) {
    this.device = device;
    this.deviceProgress = progress;
    this.emit({ device, progress });
  }
  get canChat() { return !this.requireDevice || this.device === "ready"; }
  async loadPolicy() {
    try {
      if (!await isSupported()) return;
      const remote = getRemoteConfig(this.app);
      remote.defaultConfig = { hybrid_local_question_chars: DEFAULT_POLICY.localQuestionChars,
        hybrid_local_context_chars: DEFAULT_POLICY.localContextChars,
        hybrid_max_output_tokens: DEFAULT_POLICY.maxOutputTokens,
        hybrid_cloud_model: this.config.cloudModel || DEFAULT_POLICY.cloudModel, hybrid_enabled: true };
      remote.settings.fetchTimeoutMillis = 3000;
      remote.settings.minimumFetchIntervalMillis = 60000;
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
        onDeviceParams: { createOptions: { ...ON_DEVICE_IO },
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
    if (this.device === "ready") return Promise.resolve();
    const model = globalThis.LanguageModel;
    if (!model?.create) { this.setDevice("unsupported"); return Promise.resolve(); }
    this.setDevice("preparing");
    // Call create synchronously on a setup click to preserve user activation
    // for downloading. Startup only calls it for a fully downloaded model.
    // Hold that session to keep the model loaded. Inference still uses the SDK.
    this.preparing = (async () => model.create({ ...ON_DEVICE_IO, monitor: monitor => {
      monitor.addEventListener("downloadprogress", event => {
        if (this.device === "preparing" || this.device === "downloading")
          this.setDevice(event.loaded < event.total ? "downloading" : "preparing",
            event.total > 0 ? event.loaded / event.total : 0);
      });
    } }))().then(session => {
      if (!session) throw new Error("No local model session was created.");
      this.warmSession = session;
      this.setDevice("ready");
    }).catch(() => this.setDevice("unavailable"))
      .finally(() => { this.preparing = null; });
    return this.preparing;
  }
  /**
   * Tidies a speech transcript with Gemini Nano only. Without a ready device model it returns null
   * and the transcript stays as dictated: dictated text is never sent to the cloud just to tidy it.
   */
  async polishDictation(text, { signal } = {}) {
    const transcript = String(text || "").trim();
    if (this.device !== "ready" || !transcript || transcript.length > 2000) return null;
    const started = this.now();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException("Dictation cleanup timed out.", "TimeoutError")), 8000);
    try {
      const prompt = "Rewrite this speech-recognition transcript as the message the speaker meant to type. "
        + "Keep its language, meaning, names, dates, times and numbers. Add punctuation, remove filler words and repeated words, "
        + "and fix only obvious recognition errors. Do not answer it, add information or translate it. Output only the rewritten text.\n\n"
        + `Transcript:\n${transcript}`;
      const { response } = await this.model(InferenceMode.ONLY_ON_DEVICE).generateContent(prompt, { signal: requestSignal });
      requestSignal.throwIfAborted();
      const polished = (typeof response.text === "function" ? response.text() : "").trim();
      const source = response.inferenceSource === InferenceSource.ON_DEVICE ? "ON_DEVICE" : "UNKNOWN";
      this.record({ task: "dictation_polish", requestedMode: InferenceMode.ONLY_ON_DEVICE, source, model: "Gemini Nano",
        durationMs: Math.round(this.now() - started), reason: "dictation", fallback: false, finalAnswer: false, at: new Date().toISOString() });
      // An empty or runaway rewrite is discarded in favour of what was said.
      return source === "ON_DEVICE" && polished && polished.length <= transcript.length * 2 + 40 ? polished : null;
    } catch {
      this.record({ task: "dictation_polish", requestedMode: InferenceMode.ONLY_ON_DEVICE, source: "UNKNOWN",
        durationMs: Math.round(this.now() - started), reason: "dictation", error: requestSignal.aborted ? "aborted" : "inference_failed", finalAnswer: false });
      return null;
    } finally { clearTimeout(timeout); }
  }
  async generate({ task, question, prompt, request, schema, systemInstruction, historyCount = 0,
    contextChars = 0, hasTools = false, crossShop = false, signal, finalAnswer = false, onDelta }) {
    signal?.throwIfAborted();
    if (!this.canChat) throw new Error(globalThis.document?.documentElement?.lang === "en"
      ? "Prepare on-device AI before starting a chat."
      : "チャットを始める前に端末内AIを準備してください。");
    const size = JSON.stringify(request || prompt || "").length;
    if (size > this.policy.maxRequestChars) throw new Error("This conversation is too long. Start a new conversation.");
    const route = routePolicy({ question, contextChars, historyCount, hasTools, crossShop, task }, this.policy);
    const deviceAtStart = this.device;
    const mode = route.local && deviceAtStart === "ready" ? InferenceMode.PREFER_ON_DEVICE : InferenceMode.ONLY_IN_CLOUD;
    const started = this.now();
    let response;
    let streamed = false;
    let firstTokenMs = null;
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException("Inference timed out. Please try again.", "TimeoutError")), task === "decision" || task === "booking_preflight" ? 8000 : 45000);
    let onAbort;
    const abortPromise = new Promise((_resolve, reject) => {
      onAbort = () => reject(requestSignal.reason);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) onAbort();
    });
    abortPromise.catch(() => {}); // Observed by each race; never an unhandled rejection.
    try {
      const target = this.model(mode, schema, systemInstruction);
      const useStream = typeof onDelta === "function" && !schema && typeof target.generateContentStream === "function";
      if (useStream) {
        const streamResult = await Promise.race([
          target.generateContentStream(request || prompt, { signal: requestSignal }),
          abortPromise,
        ]);
        // Race every chunk against the abort, so a stalled stream still ends at the timeout.
        const iterator = streamResult.stream[Symbol.asyncIterator]();
        try {
          for (;;) {
            const { value: chunk, done } = await Promise.race([iterator.next(), abortPromise]);
            if (done) break;
            const delta = typeof chunk?.text === "function" ? chunk.text() : "";
            if (delta) {
              if (!streamed) firstTokenMs = Math.round(this.now() - started);
              streamed = true; onDelta(delta, chunk.inferenceSource);
            }
          }
        } catch (error) {
          iterator.return?.().catch(() => {});
          throw error;
        }
        response = await Promise.race([streamResult.response, abortPromise]);
      } else {
        const result = await Promise.race([
          target.generateContent(request || prompt, { signal: requestSignal }),
          abortPromise,
        ]);
        response = result.response;
      }
      signal?.throwIfAborted();
      const source = response.inferenceSource === InferenceSource.ON_DEVICE ? "ON_DEVICE"
        : response.inferenceSource === InferenceSource.IN_CLOUD ? "IN_CLOUD" : "UNKNOWN";
      const log = Object.freeze({ task, requestedMode: mode, source, durationMs: Math.round(this.now() - started),
        firstTokenMs, model: source === "ON_DEVICE" ? "Gemini Nano" : this.policy.cloudModel,
        contextChars, maxContextChars: this.policy.localContextChars,
        reason: route.local && mode === InferenceMode.ONLY_IN_CLOUD ? `device_${deviceAtStart}` : route.reason,
        fallback: route.local && source === "IN_CLOUD",
        fallbackReason: route.local && source === "IN_CLOUD" ? mode === InferenceMode.ONLY_IN_CLOUD ? deviceAtStart : "unknown" : null,
        finishReason: response.candidates?.[0]?.finishReason || null,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        thinkingTokens: response.usageMetadata?.thoughtsTokenCount || 0,
        finalAnswer, at: new Date().toISOString() });
      this.record(log); return { response, source, log, streamed };
    } catch (error) {
      this.record({ task, requestedMode: mode, source: "UNKNOWN", durationMs: Math.round(this.now() - started),
        reason: route.reason, error: signal?.aborted ? "aborted" : "inference_failed",
        errorCode: /^[a-zA-Z0-9_/-]{1,80}$/.test(error?.code || error?.name || "") ? error.code || error.name : "unknown",
        httpStatus: Number.isInteger(error?.customErrorData?.status) ? error.customErrorData.status : null,
        finalAnswer: false });
      if (signal?.aborted) throw error;
      const english = globalThis.document?.documentElement?.lang === "en";
      if (error?.customErrorData?.status === 429) throw new Error(english
        ? "Cloud AI has reached its usage limit. Please try again later."
        : "クラウドAIの利用上限に達しました。時間をおいて再試行してください。", { cause: error });
      throw new Error(english ? "AI could not answer. Please try again in a moment."
        : "AIの返答を確認できませんでした。少し時間をおいて再試行してください。", { cause: error });
    } finally { clearTimeout(timeout); if (onAbort) requestSignal.removeEventListener("abort", onAbort); }
  }
  record(log) { this.logs.push(log); if (this.logs.length > 100) this.logs.shift(); this.emit({ log }); }
}
