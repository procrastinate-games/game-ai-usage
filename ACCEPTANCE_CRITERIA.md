# MVP acceptance criteria — privacy release

Status: implementation changes prepared; deployment and history-cleanup verification pending.

- Public `usage.json` contains only game title, non-sensitive game slug, total processed tokens, non-cached + output tokens and a completeness boolean.
- Public pages contain no session IDs, report IDs, names of tasks, start/end timestamps, agent names, per-model usage or pricing.
- Report schema `game-ai-usage/report@2` rejects all extraneous metadata.
- Locally generated reports use opaque UUID v4 IDs independent of actual agent session IDs; the local map stays under `.git`.
- Old reports with sensitive metadata are rejected by new aggregation.
- Existing source reports must be migrated and old Git history cleaned before calling the privacy cleanup complete.
- Preserve existing token totals and distinguish missing data from zero.
- Validation: `npm test`, GitHub Actions deployment, public assets inspection, and reachable Git history audit.

History rewriting is destructive. Save backups and assess affected refs before any force push. Old GitHub caches, external clones and pull request refs may remain.
