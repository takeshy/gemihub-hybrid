# Gemihub Hybrid — #BuildHybridAI 2026 Demo Video Script (English)

- **Target length:** ~2:35–2:40 (strictly under the 3:00 limit)
- **Live demo URL:** `https://hybrid.gemihub.net/`
- **Public Town Guide MCP:** `https://hybrid.gemihub.net/api/mcp`
- **Repository:** `https://github.com/takeshy/gemihub-hybrid` (Apache-2.0 License)
- **Clips folder:** `output/demo/clips/` (recorded at 1280×720, English UI)

---

## Clipchamp Assembly & Narration Script

### Scene 1 — Existing Foundation & The Problem (0:00–0:43) *(reuse existing clip)*
**Visuals:**
1. `00-existing-builder-images/02-interview.jpg` (3s) — overlay text: `Existing gemihub feature: conversational storefront builder`
2. `00-existing-builder-images/22-pen.jpg` (3s)
3. `00-existing-builder-images/05-provisional-page.jpg` (3s)
4. `01-storefronts.webm` (Robata Akari, Trattoria Sole, Canton Ryu — trim/speed up to ~10–12s)
5. Transition into `02-finder-on-device.webm` (opening seconds showing the town guide and quick-test chips)

**Narration (Clipchamp TTS):**
> Hi, this is Gemihub Hybrid — local answers, connected communities.
> Our existing platform, gemihub, already lets independent neighborhood shops create their own bespoke websites and booking pages simply by chatting with AI — no templates, no web agency needed.
> A town guide then connects those shops together.
> Here's the problem: once a shop publishes its site, sending every routine question like opening hours to a cloud LLM creates unpredictable traffic costs for a small business.
> For Build Hybrid AI 2026, I extended gemihub with a Firebase AI Logic hybrid inference layer for both the town guide and shop assistants — with no visitor API keys required.

---

### Scene 2 — Town Guide: Instant On-Device Inference & Telemetry Pill (0:43–1:06) *(re-record)*
**Visuals:**
- `02-finder-on-device-v2.webm`
  - Click the **`⚡ Local FAQ`** quick-test chip (`What are Robata Akari's opening hours and menu items?`).
  - Show the streaming answer appearing on the very first turn (no setup modal click needed when Nano is already downloaded).
  - Highlight the inline telemetry pill directly under the reply: **`⚡ On-device · Gemini Nano · ... ms · published_shop_facts`**.

**Narration (Clipchamp TTS):**
> On supported Chrome devices, the app probes Gemini Nano availability at startup so the very first turn runs locally with PREFER_ON_DEVICE.
> Gemini Nano streams answers about a shop's published facts right in the browser, and every reply displays an inline telemetry pill from the Firebase AI Logic SDK: On-device, model, latency, and routing reason — zero cloud cost for common FAQs.

---

### Scene 3 — Town Guide: Cloud Comparison & Public Town MCP (1:06–1:28) *(re-record)*
**Visuals:**
- `03-finder-cloud-compare-v2.webm`
  - Click the **`☁ Cloud Multi-Shop`** quick-test chip (`Compare Trattoria Sole and Canton Ryu for a group dinner`).
  - Highlight the inline **`☁ Cloud · gemini-3.5-flash-lite`** pill under the reply and the shop comparison cards.
  - Optional 3-second overlay/inset showing `GET https://hybrid.gemihub.net/api/mcp` JSON (`list_town_shops`, `query_shop_facts`, `search_local_events`).

**Narration (Clipchamp TTS):**
> Comparisons across shops, allergy questions, price totals, and follow-ups route to ONLY_IN_CLOUD with Gemini 3.5 Flash-Lite, protected by Firebase App Check and tunable via Remote Config.
> The town guide also exposes a public read-only MCP endpoint at `/api/mcp`, so external agents can discover published shops and local events.

---

### Scene 4 — Shop Assistant: On-Device Booking Preflight → Cloud MCP Booking (1:28–2:12) *(re-record)*
**Visuals:**
- `04-shop-hybrid-booking-v2.webm` (inside Robata Akari's reservation assistant)
  - Step 1: Click **`⚡→☁ Hybrid Booking`** (`I would like to make a reservation for Friday`).
    - Show **`⚡ On-device · Gemini Nano · ... ms · booking_preflight (JSON Schema)`** — Nano extracts partial slots on-device and deterministic code asks for the missing time and party size without any cloud call.
  - Step 2: Reply `2 guests at 19:00, name is Hybrid Demo, phone 09000000001.`
    - Show the handoff to **`☁ Cloud · gemini-3.5-flash-lite · ... (MCP: check_availability)`** → **Make this reservation?** confirmation modal → click **Reserve** → booking confirmed.

**Narration (Clipchamp TTS):**
> Inside Robata Akari's own assistant, booking starts on-device too.
> When a visitor says they want to book for Friday without a time or party size, Gemini Nano extracts the partial slots as structured JSON, and deterministic code asks for the missing details — still zero cloud calls.
> Once the date, time, and party size are complete, the chat hands off to the cloud. Existing deterministic MCP tools check live seats and pricing, and the confirmation modal ensures the model never confirms a reservation on its own.

---

### Scene 5 — Graceful Cloud Fallback & Wrap-up (2:12–2:38) *(reuse fallback clip + update end card)*
**Visuals:**
- `05-cloud-fallback.webm` (reuse existing clip)
  - Non-Nano browser answers the same question with **`Cloud`** badge and diagnostics showing `IN_CLOUD · device_unavailable · fallback`.
- End card (4–5s):
  - **Gemihub Hybrid** — Local answers, connected communities
  - Live Demo: `https://hybrid.gemihub.net/`
  - Town Guide MCP: `https://hybrid.gemihub.net/api/mcp`
  - GitHub (Apache-2.0): `https://github.com/takeshy/gemihub-hybrid`

**Narration (Clipchamp TTS):**
> And if a visitor's browser doesn't support Gemini Nano — or while the model is still downloading — chat never blocks. Firebase AI Logic falls back cleanly to the cloud and labels it honestly.
> Try the live demo at hybrid.gemihub.net, and check out our Apache-2.0 licensed code on GitHub. Thanks for watching!
