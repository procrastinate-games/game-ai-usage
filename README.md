# Game AI Usage

Privacy-first, fully static dashboard comparing token consumption across games in the [procrastinate-games](https://github.com/procrastinate-games) organization.

Derived from [claude-usage](https://github.com/phuryn/claude-usage) by Paweł Huryn (MIT); see [LICENSE](LICENSE). The original visual palette and dashboard layout are retained in a simplified, game-focused view.

## Data flow

Agents generate minimal `game-ai-usage/report@2` JSON reports in individual game repositories under `.ai-usage/`. GitHub Actions aggregates the reports into `site/data/usage.json`, deployed as Cloudflare Workers Static Assets.

**The publicly deployed JSON only contains game titles and two counts:** Total Processed Tokens and Non-cached + Output Tokens. Missing counts are `null`; incomplete totals are marked as lower bounds.

Session IDs, task titles, start/end times, session history, model names, per-agent statistics, costs, and raw token breakdowns are intentionally excluded from the public site. The source report holds the minimal token breakdown needed for correct accounting, with an opaque randomly assigned report ID.

See [agent-kit/AI_USAGE.md](agent-kit/AI_USAGE.md) for integrations and [agent-kit/report.schema.json](agent-kit/report.schema.json) for the strict report schema. Old `report@1` reports are rejected until migrated.

## Commands

```sh
npm test
npm run aggregate
npm run serve
```

GitHub Actions runs aggregation on a schedule and deploys to Workers using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Game discovery is configured in `config/games.json`.

No runtime backend, authentication, database, or write API.
