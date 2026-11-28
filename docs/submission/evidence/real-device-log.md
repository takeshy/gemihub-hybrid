# Real-device inference log

Results observed in a real Chrome browser on the public demo. Automated tests
use mocked inference and are recorded separately; nothing here is inferred from
the requested inference mode. Each entry copies the reply and the telemetry pill
the page showed, which reports the SDK's actual `inferenceSource`.

## 2026-11-28 (JST): opening hours from schema.org JSON-LD

- Deployed commit: `587969c` (shop facts passed to Gemini Nano as schema.org
  JSON-LD, including `openingHoursSpecification`).
- Page: https://hybrid.gemihub.net/s/akari/
- Question: "What are Robata Akari's opening hours?"
- Reply: "Robata Akari is open from 17:00 to 23:30 on Sunday through Saturday."
  with the link https://hybrid.gemihub.net/s/akari/
- Telemetry pill: `⚡ On-device · Gemini Nano · 4,278 ms (first token 1,933 ms) ·
  published_shop_facts (2,113 / 12,000 chars)`
- Check: the hours match the published JSON-LD (`17:00`–`23:30`, every day).
- Not recorded: Chrome version, operating system and device model.
