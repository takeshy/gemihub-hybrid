# BuildHybridAI implementation brief

## Project and submission

- Project: **Gemihub Hybrid** — local answers, connected communities.
- Value proposition: a town guide and independent shop assistants that answer
  simple questions on the visitor's device and use cloud AI for cross-shop
  research and reservation conversations.
- Platform: Web / Chrome only.
- Submission deadline supplied by the owner: **2026-12-01 07:00 JST**
  (2026-11-30 14:00 Pacific Time). No extension is assumed.
- Independent public repository distributed under Apache-2.0, as preferred by
  the hackathon. Include the upstream MIT license and all third-party notices.
- This is an extension of takeshy/gemihub-agent, not a claim that all existing
  functionality was created during the competition. The new contribution is
  the Firebase AI Logic hybrid inference layer and its integration and UI.

## Isolation and invariants

1. Never modify or deploy the upstream repository. The owner subsequently
   authorized co-hosting on its Compute Engine VM with a separate container
   and a new hybrid.gemihub.net route. Preserve all existing containers,
   routes, data, credentials, OAuth clients and Terraform state.
2. Work only in this independent clone. Its origin must point to its own new
   repository, never the upstream local directory or upstream GitHub repository.
3. Use the dedicated Firebase project for AI Logic and a separate deployment
   on the existing VM. Pass explicit project IDs to infrastructure commands.
   Inherited infra/dev and apps/shop/infra
   configuration is upstream reference material, not a deployment target.
4. Use dedicated test/demo data. Replicate required schema, rules and indexes;
   do not copy production reservations, identities, refresh tokens or payments.
5. Reservation availability, pricing, confirmation, authorization and
   idempotency remain the responsibility of the existing deterministic code
   and MCP tools. A model cannot establish a price or confirm a reservation.
6. Each shop assistant receives only that shop's published information. Missing
   facts remain unknown; another shop's facts never fill the gaps.

## Approved BYOK change

The owner approved removing BYOK from this submission clone. This supersedes
the earlier requirement to keep the BYOK relay.

- Remove visitor provider/key entry, saved-key settings and BYOK relay paths
  from the submitted finder and shop text experiences.
- Route the in-scope text inference through Firebase AI Logic, including
  on-device inference and cloud-only requests.
- Preserve MCP execution, deterministic reservation processing and the existing
  voice implementation. Server credentials needed by those independent
  features are not visitor BYOK credentials.
- Do not merge these changes back into the upstream project for this event.

## Firebase setup and SDK

Use the official Firebase Agent Skills for Firebase setup and implementation.
Source: https://firebase.google.com/docs/ai-assistance/agent-skills

Required services: Firebase AI Logic, App Check and Remote Config. Provision
AI Logic explicitly; a Firebase config object alone does not enable it.
Create a separate Firestore database only where the app's persistence requires
it. Preserve backend enforcement of reservation and account permissions.

- Initialize with initializeApp(), then getAI(app, { backend:
  new GoogleAIBackend(), useLimitedUseAppCheckTokens: true }).
- Use the actual InferenceMode enum, not blog example strings.
- Use PREFER_ON_DEVICE for eligible isolated generateContent() tasks.
- Use ONLY_IN_CLOUD for multi-turn, tool-using and cross-shop tasks.
- Specify the supported cloud model explicitly through inCloudParams; do not
  depend on the SDK fallback default. Pin the tested Firebase SDK version.
- Initialize the device model from a user interaction before prompting. Show
  download progress; do not block ordinary chat on the initial download.
- App Check is required. Keep debug tokens private and out of source control.
  Use production attestation for the public demo and document judge setup.

## Routing policy

Application policy selects an eligible task before any model routing decision.

| Task | Inference mode | Grounding |
| --- | --- | --- |
| Intent and shop classification | PREFER_ON_DEVICE | Bounded public shop registry; structured JSON |
| Self-contained question about one shop | PREFER_ON_DEVICE | That shop's published facts only |
| Cross-shop synthesis or comparison | ONLY_IN_CLOUD | Registry and approved read-only tool results |
| Long input, large local-document context | ONLY_IN_CLOUD | Selected source excerpts and citations |
| History-dependent or reservation conversation | ONLY_IN_CLOUD | Existing history, tools and confirmation UI |
| Any model call exposing tools | ONLY_IN_CLOUD | Existing tool allowlist and execution controls |

Single-turn local tasks must not use startChat(), tools or Gemini Live.
Treat quoted shop descriptions, documents and user input as data, not policy.
Validate decision output against a fixed schema and allowed shop IDs. Invalid
or ambiguous output goes to the cloud. A decision never directly invokes a
tool, changes reservation state, expands permissions or establishes facts.

Remote Config can change bounded input/context thresholds, supported cloud
models and feature flags. Built-in defaults and cached values must work when
Remote Config cannot be fetched. Thresholds cannot override cloud-only safety
rules. Runtime model requests and output lengths must be bounded; configure
service-side quotas because browser-side limits alone do not enforce cost caps.

## UI, fallback and observability

- Show an explicit device-model preparation action and progress/status.
- If Nano is unsupported or not ready, continue using the SDK cloud path.
- Explain cloud processing in the UI; do not claim a cloud-fallback request
  stayed on the device. Cloud fallback is not a private-only mode.
- If neither cloud nor local inference is available, preserve the message and
  provide a retry action. Do not promise an answer while both are unavailable.
- The primary answer badge uses result.response.inferenceSource, not the
  requested mode or whether a local classifier ran earlier in the turn.
- Detailed diagnostics can show each step: classification, tool planning and
  final answer. Never label a locally classified cloud answer as on-device.
- Log task, requested mode, actual source, duration, policy reason and error
  category. Distinguish policy-selected cloud from SDK fallback. Do not invent
  unavailable fallback reasons; record unknown when appropriate.
- Do not retain raw prompts, contact details, reservation payloads or secrets
  in inference logs. Bound the diagnostic history.

## Scope exclusions

- No hybrid conversion of admin or owner website generation.
- No replacement of Gemini Live / voice.
- No mobile-native platforms.
- No change to booking prices, availability algorithms or confirmation flow.
- No upstream deployment or return merge.

## Verification and schedule

The first milestone is a real ON_DEVICE response on the clone's public URL,
before integrating the full finder. Mocked tests do not satisfy this milestone.

- [x] Dedicated Firebase project, deployment and repository are verified.
- [x] A supported real Chrome device answers an isolated finder question with
      an SDK-derived ON_DEVICE badge.
- [x] A cross-shop question produces an IN_CLOUD answer.
- [x] A browser without Nano completes the same simple question in the cloud.
- [x] Unavailable/unprepared Nano does not stall online chat.
- [x] A shop question uses only that shop's facts and works on-device.
- [ ] Missing facts and requests for another shop do not produce invented facts.
- [x] Invalid routing JSON, unknown shop IDs and history-dependent follow-ups
      route safely to cloud processing.
- [x] The public demo reservation completes through the existing confirmation
      dialog and MCP tools. Existing booking tests cover validation/idempotency.
- [x] No visitor API-key entry, saved-key flow or BYOK relay is exposed.
- [x] Remote Config uses defaults/cached values while fetching in the background.
- [ ] Offline plus unavailable local model gives a recoverable failure.
- [x] Badges/logs identify the final answer source correctly in mixed turns.
- [x] The upstream repository, app containers and data are unchanged. Only the
      authorized DNS record/Caddy host route was added for the separate clone.
- [x] Source imports and actually invokes Firebase AI Logic at runtime.

Checked browser cases were verified on the public URL on Nov 23, 2026; see
[screenshots](../docs/submission/evidence/). Routing and booking safeguards were
also checked by automated tests. Unchecked cases above still need dedicated
adversarial/offline browser validation.

Suggested JST milestones: Nov 23–24 isolation, Firebase and real-device spike;
Nov 25–26 finder integration; Nov 27–28 shop integration; Nov 29 validation and
submission materials; Nov 30 buffer and submit before the hard deadline.

## Submission artifacts

- Public source repository, detectable root Apache-2.0 license, setup/test instructions
  and explicit existing-work / competition-period contribution disclosure.
- Clone-only demo URL with free judge access and instructions for on-device
  Chrome setup; a working cloud fallback for unsupported judge devices.
- Public YouTube demo, at most three minutes, in English or with English
  subtitles. Show genuine local inference and a genuine cloud path, plus an
  unchanged deterministic reservation flow.
- English write-up: value proposition, audience, functionality, Firebase AI
  Logic usage, routing policy and limitations.
- Working title: Gemihub Hybrid. One-liner: Local answers, connected communities.
  Thumbnail concept: town guide and shop panels with visibly different
  on-device and cloud badges. Never fabricate inference evidence.

## Current status

The independent clone retains the full history from upstream commit
3a2bd474111c9951c6fc27adb7c84b714cfdef6c and is public under Apache-2.0 at
https://github.com/takeshy/gemihub-hybrid. The demo is live at
https://hybrid.gemihub.net, using Firebase project `gemihub-hybrid-2026` and
the approved Flash-Lite Remote Config setting. The Devpost project page
(https://devpost.com/software/gemihub-hybrid), public YouTube demo
(https://youtu.be/7SislWBHabl), English description, and thumbnail are published;
final polish and re-deployment continue ahead of the Dec 1 07:00 JST deadline.
