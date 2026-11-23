# Gemihub Hybrid

**Local answers, connected communities.** An independent Web / Chrome entry
for #BuildHybridAI 2026, extending Gemihub with Firebase AI Logic hybrid inference.

[Live Web demo](https://hybrid.gemihub.net/)

**Implementation status:** the Firebase hybrid runtime and finder/shop adapters
are implemented. Real desktop Chrome has answered a grounded shop question
on-device and through the cloud. Public deployment and booking UI validation
are in progress. Firebase Web SDK `13.4.0` is pinned.
See the [implementation brief](specs/BUILD_HYBRID_AI.md) for the approved scope
and acceptance criteria, and [Firebase Agent Skills](docs/firebase-agent-skills.md)
for the official implementation guidance.

This submission clone removes visitor BYOK from the public text experience.
In-scope finder and shop text inference uses Firebase AI Logic; deterministic booking and MCP execution
remain authoritative. Existing voice is outside the hybrid conversion.
Cloud text uses `gemini-3.5-flash-lite`, explicitly configured and changeable
through Remote Config. Local eligible tasks use Gemini Nano in supported Chrome.

[English](README.md) · [日本語](README_ja.md)

**gemihub** is a non-homogenizing local town portal where independent shops can build and run their own bespoke websites simply by talking to AI, and a town-guide AI coordinates across every shop's AI and local community documents to recommend places and itineraries via text, voice, and multiple languages.

> **Existing work and isolation:** This project starts from
> [takeshy/gemihub-agent](https://github.com/takeshy/gemihub-agent), commit
> `3a2bd474111c9951c6fc27adb7c84b714cfdef6c`. The sections below describe the
> inherited application. The competition-period work is the new hybrid layer,
> integration and diagnostics. There is no return merge to upstream. The demo
> co-hosts in its own container, preserving the original app containers and data.
> Inherited `infra/dev/` and `apps/shop/infra/` deployment
> examples target upstream resources and must not be run for this clone.

### Run the hybrid demo

```sh
npm ci
npm run build:finder
npm run build:shop
npm run dev:hybrid
```

Open `http://localhost:8088/`. The three restaurants are fictional sample shops;
demo reservations are held in memory and reset when the demo container restarts.
No real mail, payment account or upstream reservation data is used.

Use **AI processing and settings → Prepare on-device AI** in supported desktop
Chrome with the Prompt API enabled. Initial model download can take time. The
answer badge reports the SDK's actual inference source. Simple published-shop
questions use a single prompt; comparisons, tools and follow-up conversations
use the cloud. The first request during model preparation also uses the cloud.

New runtime code: [`hybrid/`](hybrid/), with regression tests in
[`tests/hybrid.test.mjs`](tests/hybrid.test.mjs). The standalone deployment is in
[`infra/hybrid/`](infra/hybrid/). Shared third-party runtime files stay unchanged.

---

## Key Features

- **Conversational Storefront Builder (`apps/shop/`)**  
  Restaurants, craft & stationery stores, salons, and other local businesses can generate and update custom-designed websites, menus, and booking flows using natural language and photos.
- **Town-Guide AI × Distributed Shop AIs**  
  Given combined visitor constraints (date/time, party size, dietary restrictions, follow-up stops, etc.), the town-guide AI queries participating shops' read-only MCP agents upon user confirmation, compares availability and offerings, and suggests a multi-stop route.
- **Voice & Multilingual Guidance**  
  Visitors can consult the town guide and individual shop AIs via live voice conversation as well as multilingual text (e.g., English and Japanese).
- **Local Document Retrieval (PDF, Markdown, etc.)**  
  Town operators can upload and publish local notices, public facility guides, and event flyers (such as local festival PDFs) so the portal can answer community questions with source citations.
- **Firebase Hybrid Text AI**  
  The submission's visitor text experience runs through Firebase AI Logic without API key entry.

When managed voice AI is enabled, **Talk to AI** appears beside the heading at the top of both the town-guide and shop chat screens. It opens a compact voice panel at the bottom right while leaving the rest of the page usable; closing the panel or pressing Esc ends the microphone session. The button appears inside chat, and shop confirmations remain on screen. See [AI and voice settings](docs/managed-ai.md#親の音声会話).

---

## Core Stack

- **Google Gemini API**
  - Shop discovery & agent queries: `gemini-4-hydrogen` (low)
  - Live voice interaction: `gemini-3.8-live`
  - Storefront/theme and page HTML/CSS generation: `gemini-4-argon`
  - Visual review and genre classification support
- **Open Agentic Web** (built on [agentify-website](https://github.com/cognizant-ai-labs/agentic-web))  
  Decentralized federation between the town portal and individual shop agents
- **Runtime & Frontend**  
  Node.js 24+ / TypeScript / React 19 / Vite (npm workspaces monorepo)

---

## Repository Structure

| Path | Purpose |
| --- | --- |
| `site/` | Town-guide portal (public frontend and parent agent manifest/network) |
| `apps/shop/` | Storefront builder, owner admin, and shop AI app (see [apps/shop/README.md](apps/shop/README.md)) |
| `admin/` | Portal operator server (shop directory, local document uploads, AI page editor) |
| `scripts/` | Build scripts and combined local demo runner |
| `docs/` / `specs/` | Architecture notes, setup guides, and feature specifications |

---

## Quick Start

### Prerequisites
- **Node.js 24+**

### 1. Install, Build & Test

```sh
npm ci
cp .env.example .env   # Set GEMINI_API_KEY and optional settings as needed
npm run build
npm test
```

### 2. Run the Combined Local Demo

Launch the town portal, portal admin server, and 3 demo restaurant storefronts together:

```sh
npm run dev:demo
```

Default local endpoints:
- Town-guide portal: **http://localhost:8090/**
- Portal admin UI: **http://localhost:8091/**
- Shop demo app: **http://127.0.0.1:3000/**

> Override ports via `FINDER_PORT`, `ADMIN_PORT`, and `SHOP_PORT` (`Ctrl+C` stops all processes).

---

## Common Commands

| Command | Description |
| --- | --- |
| `npm run build` | Build the town portal, admin UI, and shop app |
| `npm run check` | Run type and build checks across workspaces |
| `npm test` | Run unit tests for both the portal and shop app |
| `npm start` | Start only the town portal (`http://localhost:8090/`) |
| `npm run admin` | Start only the portal admin server (`http://127.0.0.1:8091/`) |
| `npm run start:shop` / `npm run dev:shop` | Start / dev-watch only the shop app |
| `npm run storybook` | Launch Storybook for portal and storefront UI |
| `npm run dev:demo` | Launch the combined portal, admin, and demo shop servers |

---

## Documentation

- Shop app details: [apps/shop/README.md](apps/shop/README.md) ([日本語](apps/shop/README_ja.md))
- Managed AI vs. BYOK & voice setup: [docs/managed-ai.md](docs/managed-ai.md)
- Authentication & Cloud Storage: [docs/storage-auth.md](docs/storage-auth.md)
- Monorepo overview: [docs/monorepo.md](docs/monorepo.md)
- Specifications: [Shop Introduction](specs/SHOP_INTRODUCTION_SPEC.md) / [Restaurant Booking](specs/restaurant-spec.md) / [Admin UI](specs/ADMIN_SPEC.md)

---

## Third-Party Notices

Parts of the portal and agent runtime (`site/runtime/` and `vendor/agentify-website/`) incorporate [agentify-website](https://github.com/cognizant-ai-labs/agentic-web) by Cognizant AI Labs under the Apache License 2.0.
