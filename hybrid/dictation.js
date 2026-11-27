// Microphone dictation into the chat input through the browser's own SpeechRecognition.
// Adapted from the shop builder's dictation (itself from kakeratta): the visitor's edits are kept,
// cumulative results are consumed once, and a final trailing end word ("over") sends the message.
// When Gemini Nano is ready the dictated words are tidied on the device before they are sent.

export const defaultEndWords = "over, オーバー, 以上";

export function speechRecognitionConstructor(scope = globalThis) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

const unspacedScript = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Splits a trailing end word off a final transcript. */
export function endWord(transcript, final, words = defaultEndWords) {
  const phrases = words.split(/[,、\n]/).map(value => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = phrases.map(phrase => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "over" must be a word of its own, not the end of "leftover".
    return (!unspacedScript.test(phrase) && /^[\p{L}\p{N}_]/u.test(phrase) ? "(?<![\\p{L}\\p{N}\\p{M}_])" : "") + escaped;
  }).join("|");
  const command = pattern ? new RegExp(`(?:${pattern})[\\s。．.!！?？、,]*$`, "iu") : null;
  const send = final && !!command && command.test(transcript);
  return { spoken: send ? transcript.replace(command, "").trimEnd() : transcript, send };
}

function join(base, text) {
  const spoken = text.trim();
  if (!base.trim()) return spoken;
  if (!spoken) return base;
  // Japanese and Chinese text runs on without a space.
  return /[\s　-鿿＀-￯]$/.test(base) || /^[,.?!、。？！]/.test(spoken) ? base + spoken : `${base} ${spoken}`;
}

/**
 * @param {{ input: { value: string, dispatchEvent(event: Event): boolean }, language: string,
 *   createRecognition: () => any, polish?: (text: string, options: { signal: AbortSignal }) => Promise<string | null>,
 *   send?: () => void, endWords?: string,
 *   onState: (state: { status: "idle" | "listening" | "polishing", error?: string }) => void,
 *   messages: Record<string, string> }} options
 */
export function createDictation({ input, language, createRecognition, polish, send, endWords = defaultEndWords, onState, messages }) {
  let recognition = null;
  let polishing = null;
  let rendered = null;
  const setValue = value => {
    rendered = value;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const publish = (status, error = "") => onState({ status, ...(error ? { error } : {}) });

  // Tidies the words dictated after `base`; the visitor's edits made meanwhile win.
  async function finish(base, spoken, sendAfter) {
    const dictated = input.value;
    if (spoken.trim() && polish) {
      const controller = new AbortController();
      polishing = controller;
      publish("polishing");
      try {
        const polished = await polish(spoken.trim(), { signal: controller.signal });
        if (polishing === controller && polished && input.value === dictated) setValue(join(base, polished));
      } catch { /* The dictated text stays as it is. */ }
      if (polishing !== controller) return;
      polishing = null;
    }
    publish("idle");
    // The end word sends only the dictated message, never one the visitor is still editing.
    if (sendAfter && input.value.trim() && input.value === rendered) send?.();
  }

  function start() {
    polishing?.abort(); polishing = null;
    let current;
    try { current = createRecognition(); } catch { publish("idle", messages.unsupported); return; }
    recognition = current;
    current.lang = language;
    current.continuous = true;
    current.interimResults = true;
    let base = input.value, lastRendered = base, results = [], consumed = 0, spoken = "", failed = false, ended = false;
    rendered = base;
    // Text the visitor typed or deleted is theirs: earlier hypotheses are never written back,
    // and only speech after the edit is appended.
    const preserveEdits = () => {
      if (input.value === lastRendered) return;
      base = input.value; lastRendered = base; rendered = base;
      consumed = Math.max(consumed, results.length);
      spoken = "";
    };
    current.onresult = event => {
      if (recognition !== current) return;
      preserveEdits();
      results = Array.from({ length: event.results.length }, (_, index) => event.results[index]);
      const pending = results.slice(consumed);
      const draft = endWord(pending.map(result => result[0]?.transcript || "").join(""), pending.length > 0 && pending.every(result => result.isFinal), endWords);
      spoken = draft.spoken;
      const text = join(base, spoken);
      if (text !== lastRendered) { lastRendered = text; setValue(text); }
      if (draft.send) {
        ended = true;
        recognition = null;
        current.onresult = null; current.onerror = null; current.onend = null;
        try { current.stop(); } catch { /* Already stopped. */ }
        void finish(base, spoken, true);
      }
    };
    current.onerror = event => {
      if (recognition === current) recognition = null;
      const error = event.error === "not-allowed" || event.error === "service-not-allowed" ? messages.denied
        : event.error === "no-speech" ? messages.noSpeech
        : event.error === "aborted" ? "" : messages.failed;
      failed = true;
      publish("idle", error);
    };
    current.onend = () => {
      if (recognition === current) recognition = null;
      if (!failed && !ended) { preserveEdits(); void finish(base, spoken, false); }
    };
    try { current.start(); } catch { recognition = null; publish("idle", messages.failed); return; }
    publish("listening");
  }

  function stop() {
    const current = recognition;
    recognition = null;
    if (current) { try { current.stop(); } catch { /* Already stopped. */ } }
  }

  return {
    toggle() { if (recognition) stop(); else start(); },
    /** Ends dictation at once, keeping the text as it is (for example, when the message is sent). */
    cancel() {
      const current = recognition;
      recognition = null;
      if (current) {
        current.onresult = null; current.onerror = null;
        current.onend = () => publish("idle");
        try { current.abort(); } catch { /* Already stopped. */ }
      }
      if (polishing) { polishing.abort(); polishing = null; publish("idle"); }
    },
    get active() { return !!recognition; },
  };
}
