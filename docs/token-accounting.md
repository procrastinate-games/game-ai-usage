# Token accounting

Reports use four disjoint categories: non-cached input, output (including thinking), cache reads and cache writes. Unknown values remain `null`.

- **Total Processed Tokens:** input + output + cache read + cache write.
- **Non-cached + Output Tokens:** input + output.

The collector uses provider-specific normalization and prevents overlapping session counts. Reports are cumulative snapshots with opaque, random report IDs. Local log selection and deduplication use a private lookup stored inside `.git` rather than publishing the underlying session ID.

The public dashboard exposes only aggregated totals per game. Model-specific counts, agent names, precise times, activity histories, and task descriptions are not published. All dated pricing and model normalization code remains available internally if needed later; costs are not displayed.

Legacy `report@1` includes sensitive data and is rejected. Existing reports must be migrated to `report@2` before the old data is removed from history.
