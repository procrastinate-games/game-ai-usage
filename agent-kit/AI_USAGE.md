# AI usage reports — privacy-safe format

Reports are stored in public game repositories. Do not include session IDs, raw task descriptions, session start/end times, full transcripts, local paths, emails, credentials or prompts.

The shared reporter reads local Claude Code / Codex / Gemini logs and emits only:
- an opaque random UUID v4 report ID (for deduplication);
- repository and calendar date;
- data accuracy and model-specific token counts.

The source session ID is used locally to choose the log but is never written to the report. A private mapping in the local Git directory reuses the same random report ID when a session is reported again. Never commit the mapping.

## Install and run

```sh
curl -fsSL https://raw.githubusercontent.com/procrastinate-games/game-ai-usage/main/agent-kit/report-usage.mjs -o "${TMPDIR:-/tmp}/report-usage.mjs"
node "${TMPDIR:-/tmp}/report-usage.mjs" --agent claude-code
# or: --agent codex
# or: --agent gemini-cli
```

For other agents, pass `--unknown` when exact counts are unavailable; do not invent numbers. To report observed counts, use `--manual` and explicit token fields. Do not pass a task description.

Commit `.ai-usage/usage-<random-uuid>.json` with your task's code changes. Use `[skip ci]` on report-only commits to avoid republishing unchanged games.

**Never commit legacy `game-ai-usage/report@1` reports.** Delete or migrate them before recording new usage. The aggregator rejects them.

## Codex Cloud (no token access)

Before finishing a task, create `.ai-usage/usage-<random-uuid-v4>.json` with this structure, using a fresh random UUID and the repository owner/name. No timestamps, task titles or session identifiers.

```json
{
  "schema": "game-ai-usage/report@2",
  "report_id": "<random UUID v4>",
  "repo": "<owner/name>",
  "date": "<UTC date YYYY-MM-DD>",
  "accuracy": "unknown",
  "models": [{
    "provider": "openai",
    "model": null,
    "price_tier": null,
    "calls": null,
    "input_tokens": null,
    "output_tokens": null,
    "reasoning_tokens": null,
    "cache_read_tokens": null,
    "cache_write_tokens": null,
    "cache_write_5m_tokens": null,
    "cache_write_1h_tokens": null
  }]
}
```

Do not fabricate token counts or model names.
