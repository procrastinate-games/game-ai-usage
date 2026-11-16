# AGENTS.md

Guidance for coding agents working on **this dashboard repository**. Instructions for agents working in *game* repositories, telling them how to report their usage, are in [agent-kit/AI_USAGE.md](agent-kit/AI_USAGE.md).

## Shape

- Static site in `site/`: `index.html`, `style.css`, `app.js` (an ES module, Chart.js from a pinned CDN URL), and `lib/accounting.js` (shared accounting and pricing logic). There is no build step.
- `scripts/aggregate.mjs` turns the GitHub reports into `site/data/usage.json`. CI generates and commits that file, so don't hand-edit it.
- `agent-kit/report-usage.mjs` is a standalone reporter that agents download raw. It must stay a single file with no imports from this repository.
- `pricing.json` holds verified prices, and `config/games.json` holds the discovery settings.
- Node 22+, no npm dependencies. Tests: `npm test`.

## Invariants

1. **Never fabricate usage.** Unknown values are `null` all the way to the UI. Aggregates show the known part with "≥" and an incomplete marker.
2. **Normalized token fields are disjoint.** `input_tokens` counts non-cached input only, `output_tokens` includes reasoning, and the cache read and cache write counts are separate. Total Processed is the sum of all four. Non-cached + Output is input plus output. Provider rules are in `docs/token-accounting.md`.
3. **No double counting.**
   - Claude Code: dedupe by `message.id` (last line wins), and count only lines whose `sessionId` equals the transcript's own id, because forks copy their parent's lines.
   - Codex: `total_token_usage` is a running total shared by child threads. Deduplicate events and use deltas; never sum per-file totals.
   - Reports: one report per `agent:session_id`, and a newer snapshot replaces an older one.
4. **No price fallback.** A model missing from `pricing.json` has cost `null` ("no verified price"). Tiered models need a per-request `price_tier`, and dated prices use `periods`. A cache write needs its 5m/1h split when the two durations have different prices.
5. Costs are API-equivalent estimates. Label them that way and never present them as subscription spend.
6. The UI is ported from [phuryn/claude-usage](https://github.com/phuryn/claude-usage) (MIT). Keep its look and the attribution in the footer and README.
7. Deploy only to `workers.dev`. Don't add `routes` or custom domains to `wrangler.jsonc`.

## Updating prices

Check the official pricing pages linked in `pricing.json` → `sources`. Update the prices and set `verified_at`. Add a model only when the official page lists its price.
