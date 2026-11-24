# Gemihub Hybrid — #BuildHybridAI 2026 Demo Video Script (English)

- **Target length:** ~2:35–2:45 (strictly under the 3:00 limit)
- **Live demo URL:** `https://hybrid.gemihub.net/`
- **Repository:** `https://github.com/takeshy/gemihub-hybrid` (MIT License)
- **Clips folder:** `output/demo/clips/` (recorded at 1280×720, English UI)

---

## Clipchamp Assembly & Narration Script

### Scene 1 — Existing Foundation & The Problem (0:00–0:35)
**Visuals:**
1. `00-existing-builder-images/02-interview.jpg` (3s) — overlay text: `Existing gemihub feature: conversational storefront builder`
2. `00-existing-builder-images/22-pen.jpg` (3s)
3. `00-existing-builder-images/05-provisional-page.jpg` (3s)
4. `01-storefronts.webm` (Robata Akari, Trattoria Sole, Canton Ryu — trim/speed up to ~10–12s)
5. Transition into `02-finder-on-device.webm` (opening seconds showing the town guide)

**Narration (Clipchamp TTS):**
> Hi, this is Gemihub Hybrid — local answers, connected communities.
> Our existing platform, gemihub, already lets independent neighborhood shops create their own bespoke websites and booking pages simply by chatting with AI — no templates, no web agency needed.
> A town guide then connects those shops together.
> Here's the problem: once a shop publishes its site, sending every routine question like opening hours to a cloud LLM creates unpredictable traffic costs for a small business.
> For Build Hybrid AI 2026, I extended gemihub with a Firebase AI Logic hybrid inference layer for both the town guide and shop assistants — with no visitor API keys required.

---

### Scene 2 — Town Guide: On-Device Inference (0:35–1:05)
**Visuals:**
- `02-finder-on-device.webm`
  - Question: `What are the opening hours for Robata Akari?`
  - Highlight the green **`On-device`** badge and the diagnostics log (`single_shop · ON_DEVICE · ... ms`).

**Narration (Clipchamp TTS):**
> On supported Chrome devices, standalone questions about a single shop's published facts use PREFER_ON_DEVICE.
> Gemini Nano answers directly in the browser, and the badge reports the real inferenceSource from the Firebase AI Logic SDK: On-device — zero cloud inference cost for common FAQs.

---

### Scene 3 — Town Guide: Cloud Cross-Shop Comparison (1:05–1:35)
**Visuals:**
- `03-finder-cloud-compare.webm`
  - Question: `Compare Robata Akari and Trattoria Sole for a dinner with friends.`
  - Highlight the blue **`Cloud`** badge, the cross-shop comparison, and shop cards.

**Narration (Clipchamp TTS):**
> When a visitor compares multiple shops, asks follow-ups, or exceeds our input threshold, our routing policy switches to ONLY_IN_CLOUD with gemini-3.5-flash-lite, protected by Firebase App Check.
> Both the cloud model and input limits can be tuned live via Firebase Remote Config without redeploying.

---

### Scene 4 — Shop Assistant: On-Device Q&A → Cloud Booking (1:35–2:15)
**Visuals:**
- `04-shop-hybrid-booking.webm`
  - Step 1: `What are your opening hours?` → **`On-device`** badge
  - Step 2: `I'd like to reserve seats for 2 guests on Nov 25 at 19:00. Name is Hybrid Demo, phone 09000000001.` → **`Cloud`** badge → MCP tool execution → **Make this reservation?** confirmation modal → **Reserve** → booking confirmed.

**Narration (Clipchamp TTS):**
> Inside Robata Akari's own assistant, the same handoff happens in one chat.
> First, opening hours are answered On-device using only this shop's published facts.
> Next, booking a table switches to Cloud. Existing deterministic MCP tools verify live availability and pricing, and the confirmation modal ensures the model never confirms a reservation on its own.

---

### Scene 5 — Graceful Cloud Fallback & Wrap-up (2:15–2:40)
**Visuals:**
- `05-cloud-fallback.webm`
  - Non-Nano browser answers the same question with **`Cloud`** badge and diagnostics showing `IN_CLOUD · device_unavailable · fallback`.
- End card (3–5s):
  - **Gemihub Hybrid** — Local answers, connected communities
  - Live Demo: `https://hybrid.gemihub.net/`
  - GitHub (MIT): `https://github.com/takeshy/gemihub-hybrid`

**Narration (Clipchamp TTS):**
> And if a visitor's browser doesn't support Gemini Nano — or while the model is still downloading — chat never blocks. Firebase AI Logic falls back cleanly to the cloud and labels it honestly.
> Try the live demo at hybrid.gemihub.net, and check out our MIT-licensed code on GitHub. Thanks for watching!
