import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = path.join(ROOT, 'test', 'fixtures');
export const pricing = JSON.parse(fs.readFileSync(path.join(ROOT, 'pricing.json'), 'utf8'));
export const gamesConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/games.json'), 'utf8'));

// Run the standalone reporter. Returns { status, stdout, stderr, json }.
export function runReporter(args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'agent-kit/report-usage.mjs'), ...args], { encoding: 'utf8', cwd: opts.cwd || ROOT, env: { ...process.env, ...opts.env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
export const rowOf = (report, model, tier = null) => report.models.find((m) => m.model === model && m.price_tier === tier);
