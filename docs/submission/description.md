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

Independent shop owners can already build a website in gemihub by chatting with AI.

For #BuildHybridAI 2026, I added Firebase AI Logic hybrid inference to the town
guide and visitor-facing shop assistants. Visitors can discover and compare
shops in the guide, ask a shop about its published information, and make a
reservation with that shop's assistant.

## How we built it

I built a shared Firebase AI Logic wrapper for both assistants. Its single-turn
`generateContent()` call prefers Gemini Nano for a standalone question about one
shop's published facts, such as its opening hours or address, when no tools are
needed and the request fits within **1,200 characters** of question text and
**12,000 characters** of context. Comparisons, follow-ups, live availability,
bookings, and requests over either limit use `gemini-3.5-flash-lite` in the cloud,
and I can adjust both limits through Remote Config without redeploying.

Existing MCP tools handle availability, prices, and reservation confirmation.
Firebase App Check helps protect cloud requests from abuse. After each answer,
the chat shows whether it ran on the device or in the cloud using the inference
source reported by the SDK.

## Challenges we ran into

Chrome needs a user action to prepare Gemini Nano, and the first download can
take time. I added a setup button and kept chat available through the cloud
while Nano was getting ready.

A single reservation can take several model calls. I hit the daily request
limit for `gemini-4-hydrogen` during testing, switched to `gemini-3.5-flash-lite`
through Remote Config, and verified the full reservation flow.

## Accomplishments that we're proud of

I verified that a visitor could ask a shop about its hours on-device and then
confirm a sample reservation in the same chat using the cloud. In a separate
desktop Chrome run, one town-guide answer about opening hours took **3.7 seconds**
of on-device inference.

## What we learned

I learned to choose where AI runs for each request. A question about opening
hours can be answered on the device using published shop information. A
reservation needs a current availability check and the visitor's confirmation.
The app can make that choice as the conversation moves from a question to a
booking.

## What's next for Gemihub Hybrid

My next priority is to give agents on other websites read-only access to
the town guide through a public MCP endpoint. A hotel's assistant could ask
where two vegetarian guests can eat this weekend and what events are
happening nearby. The town guide would ask shop assistants about menus and
availability, then combine their replies with local event listings.
