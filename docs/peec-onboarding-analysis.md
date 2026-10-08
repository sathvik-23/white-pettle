# Peec AI onboarding and results UI: what we copied and why

Source: a walkthrough of Peec's agency onboarding (app.peec.ai/brand/*, Oct 2026), their public docs (docs.peec.ai), and the `/brand/results` screen.

## Peec's onboarding pattern

1. **One question per screen, under a live preview of the product.** The top half of every step is a ghosted copy of the real app (sidebar, filter chips, chart skeleton). It fills in as you answer: your brand name appears in the sidebar, then topics, then the prompt table, then real results. You're always looking at the product you're setting up.
2. **A single, glowing pill input** with a black round arrow button. Suggestions sit under it as small chips (domain, brand name, countries).
3. **Steps:** website → where you're based → client site → where prompts run (country, language, city) → **brand profile** → where you sell (map, Global/Continent/Country/…) → "Generating topics…" → **review topics** → **prompt focus** → "Your full prompt set is ready" → **review prompt set** → "Workspace is almost ready" → pricing.
4. **Detailed reviews open as full-height sheets**, not new pages:
   - *Review your brand profile*: Description, Category, Brand identity, Products & services, Personas, as editable chips. One button: "Looks good".
   - *What should your prompts focus on?*: Research / Compare options / Take action cards, a non-branded vs branded bar, an intent-distribution bar (informational / commercial / transactional). "Generate prompts".
   - *Review your prompt set*: topics with checkboxes and counts on the left, a prompt table (branding, intent, persona) in the middle, a coverage panel on the right (personas × countries, branded split, intent split). Footer: "Tracking 240 prompts · Cancel · Show results".
5. **Everything is pre-filled.** The person reviews and removes; they rarely type.
6. **The reveal.** "{Brand}'s workspace is almost ready" over a scrollable preview of the real overview (visibility bars per brand with logos, Top 5 brands table, chat cards, top domains, domain types), with one CTA: "See full results".

## Peec's results UI

Light, neutral, Linear-like. A left sidebar grouped Home / Brand / Prompts / Sources / Optimize / Results. A breadcrumb header with Agent and Help buttons. Filter chips. A KPI strip with deltas (Visibility, Sentiment, Position, Win rate, SoV, strongest and weakest model). Brand table columns: Visibility, SoV, Position. Top domains as grey bars with favicons and retrieval counts, plus a domain-types card. The chat view highlights brand mentions as pills and has a details panel (brands, query fan-outs, sources) with previous/next navigation.

## What White Petal does now

| Peec | White Petal |
|---|---|
| Ghosted app preview + one question | Same. Each step renders `frame()` above `obAsk()` |
| Brand profile sheet | Same fields, plus company name and facts (used for fact-checking). `api/site` now also returns identity, products and personas |
| Where you sell | Market pill with chips, which feeds prompt writing |
| Competitors in settings | A dedicated "Review your competitors" step, because White Petal tracks rivals in every answer |
| Topics → focus → prompts | Same. Uses new `topics` and `topicQuestions` writers in `api/write`. Prompts are tagged topic / intent / persona |
| Branded share | Fixed at 0% on purpose: White Petal leaves your name out, so any mention is earned |
| Models in workspace settings | AI engine picker in the focus sheet |
| Review prompt set | Same three-column sheet, with coverage by persona, intent and engine |
| (paid analysis runs later) | "Run analysis" starts the live agent screen (unchanged), then the "workspace is ready" reveal with real numbers |
| Results dashboard | Overview, My website, Insights, Perception, All prompts, Domains, Gap analysis, Actions, Ranking, Chats, an engine filter, a chat details modal, and an Agent drawer |

We left out sentiment (not measured yet), time-series charts (one run per check, so we compare against the previous run instead) and pricing.
