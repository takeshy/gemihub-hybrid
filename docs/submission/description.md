## Inspiration

When I was a student, Nakazakicho in Osaka was a quiet neighborhood of old row
houses. Affordable rents drew young creatives, and cafés and small shops opened
in those old homes. Over time, Nakazakicho became a popular neighborhood with a
culture of its own.

Most of what I see about Nakazakicho online is articles about individual shops.
I wondered what would happen if shopkeepers could tell their neighborhood's
story together. Could a website give visitors a sense of what it feels like to
walk those streets?

With AI, an independent shopkeeper can build a website that feels like their
own just by having a conversation. A town guide can bring together what each
shop chooses to publish and help visitors discover things they might miss when
looking up shops one by one.

If every question about opening hours goes to a cloud model, costs can grow
with traffic. It's hard for a small shop to budget for traffic it can't predict,
especially if the service is misused. On supported devices, AI in the visitor's
browser can answer common questions using what the shop has already published.
Visitors can find out what they need before they go, without waiting for someone
at the shop to reply. That's the kind of town guide I wanted to build.

## What it does

Local questions stay on the visitor's device at zero cost to small shops; cloud AI and deterministic MCP tools step in only when live inventory or cross-shop reasoning is required.

### Core Value Inherited from `gemihub`

Independent shop owners can already build and publish bespoke storefronts in `gemihub` through conversation, backed by a deterministic reservation ledger and per-shop read-only MCP endpoints.

### What We Built During #BuildHybridAI 2026

- **Firebase AI Logic Hybrid Runtime (`hybrid/`)**: Removed visitor BYOK and routed both the town guide and visitor-facing shop assistants through `firebase/ai` (`GoogleAIBackend`, `useLimitedUseAppCheckTokens: true`) with startup `LanguageModel.availability()` probing, a 250 ms preparation race guard, and `generateContentStream()` streaming.
- **3-Tier Hybrid Routing & Slot Preflight (`hybrid/policy.js`)**: Combines deterministic policy checks with Gemini Nano JSON Schema structured outputs (`DECISION_SCHEMA` and `BOOKING_PREFLIGHT_SCHEMA`) and Remote Config bounds (`hybrid_local_question_chars`, `hybrid_local_context_chars`, `hybrid_cloud_model`).
- **Transparent Judge UX (`hybrid/browser.js`, `hybrid/style.css`)**: Shows an inline telemetry pill under every assistant reply (SDK-reported `inferenceSource`, model, latency, policy reason, context usage, and MCP tool names) plus one-click verification chips for Local FAQ, Hybrid Booking Handoff, and Cloud Multi-Shop comparison.
- **Public Town Guide Read-Only MCP (`scripts/town-mcp.mjs`)**: Exposes `/api/mcp` (`list_town_shops`, `query_shop_facts`, `search_local_events`) for external agents while keeping live booking confirmation strictly deterministic on each shop's page.

## How we built it

Both assistants share a **3-Tier Hybrid Routing Pipeline** built on Firebase AI Logic Web SDK `13.4.0`:

1. **Tier 1 — On-Device Classification & Booking Preflight (Gemini Nano + JSON Schema)**: Passes `DECISION_SCHEMA` and `BOOKING_PREFLIGHT_SCHEMA` via `onDeviceParams.promptOptions.responseConstraint`. When a visitor says *"I want to book Robata Akari this Friday"* without a time or party size, Gemini Nano extracts the partial slots on-device, and deterministic code (not model text) asks for the missing items—avoiding unnecessary cloud calls until the live availability check is actually ready.
2. **Tier 2 — On-Device Grounded Q&A with Streaming (`PREFER_ON_DEVICE`)**: Self-contained questions about one shop's published facts (hours, address, menu items, vibe, dietary notes) run on Gemini Nano via `generateContentStream()` within Remote Config limits (**1,200** question chars / **12,000** context chars) on the first turn only, grounded strictly in that shop's published JSON.
3. **Tier 3 — Cloud Synthesis & Deterministic MCP (`ONLY_IN_CLOUD`)**: Cross-shop comparisons, local community document search, allergy and price questions, every history-dependent follow-up, and live seat checks or booking confirmations route to `gemini-3.5-flash-lite` in the cloud protected by Firebase App Check. Existing deterministic MCP tools remain the sole authority for availability, pricing, and confirmation.

### Why Hybrid Matters for Small Shops

For an independent restaurant or café, unpredictable traffic spikes or casual browsing can make pay-per-token cloud LLM bills impossible to budget. Offloading routine published-fact Q&A and pre-booking slot collection to the visitor's browser with Gemini Nano cuts cloud calls by up to **67%** across a typical 6-turn discovery-to-booking journey (from 6 cloud calls down to 2), reserving App Check-protected cloud inference for real transactions.

## Challenges we ran into

Chrome requires a user gesture to download Gemini Nano, and an early asynchronous race between click-triggered `prepareDevice()` and `generate()` caused even already-downloaded browsers to fall back to the cloud on the first turn. Probing `LanguageModel.availability()` at startup (which requires no gesture) and adding a bounded 250 ms race wait eliminated first-turn cloud forcing without ever blocking chat during initial downloads.

A single reservation can also require multiple model turns. After hitting daily request limits on `gemini-4-hydrogen` during testing, I switched the cloud model to `gemini-3.5-flash-lite` via Remote Config without redeploying and added on-device booking preflight so incomplete booking messages no longer consume cloud quota.

## Accomplishments that we're proud of

What I am most proud of is building a model where a storefront created simply through natural conversation can offer visitors an AI assistant at low, predictable cost—and where connecting those individual shops into a single town guide creates a better experience for all three sides:

- **For independent shops**: Owners can publish an AI-assisted storefront without engineering effort or fear of runaway cloud bills, because routine published-fact questions and booking preflight run on the visitor's own device.
- **For visitors**: People exploring the neighborhood get fast, multilingual answers and a seamless handoff from town-wide discovery to a confirmed reservation, without hunting across scattered pages or waiting for manual replies.
- **For the neighborhood as a whole**: Each shop keeps its own voice while coming together as one connected town—and with the new public read-only Town Guide MCP endpoint (`/api/mcp` exposing `list_town_shops`, `query_shop_facts`, and `search_local_events`), external agents can also discover published shops and local events.

On the engineering side, I verified real on-device (`ON_DEVICE`) answers in desktop Chrome alongside automatic cloud fallback (`IN_CLOUD`) on unsupported browsers and full deterministic reservation confirmation in the same chat, with SDK-verified telemetry pills on every reply.

## What we learned

When neighborhood and shop information is organized with clear, ontology-like structure, even a compact on-device model like Gemini Nano becomes surprisingly capable—accurately answering published-fact questions, identifying the right shop, and extracting structured booking parameters locally. At the same time, that same structured foundation is what lets cloud AI and MCP scale outward—from one shop to a whole neighborhood, and eventually from one town to another.

The biggest takeaway is that hybrid AI works best when we balance **the expressive freedom of natural language** (letting shopkeepers tell their story in their own words and visitors ask anything conversationally) with **well-formalized data structures** (bounded shop facts, schemas, and deterministic tools) that both on-device and cloud models can rely on.

## What's next for Gemihub Hybrid

- Connect external neighborhood partners (such as local hotels and transit guides) to the Town Guide `/api/mcp` endpoint for cross-site itinerary planning.
- Expand on-device multimodal support (e.g., menu photo understanding) as Chrome Built-in AI capabilities mature.
