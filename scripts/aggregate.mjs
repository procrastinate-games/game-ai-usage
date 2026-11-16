#!/usr/bin/env node
// Aggregates .ai-usage/*.json reports from the games of a GitHub org into site/data/usage.json.
// Zero dependencies, Node 22+. Read-only against GitHub.
//   node scripts/aggregate.mjs [--out site/data/usage.json] [--local-reports <dir>] [--config config/games.json]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReport, normalizeModelRow, processedTokens, nonCachedPlusOutput } from '../site/lib/accounting.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

function titleFromName(name) {
  return name.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function getToken() {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (t) return t;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

function makeClient(fetchImpl, token) {
  const headers = { 'user-agent': 'game-ai-usage-aggregator', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  const get = (url, accept = 'application/vnd.github+json') => fetchImpl(url.startsWith('http') ? url : API + url, { headers: { ...headers, accept } });
  async function json(url) {
    const res = await get(url);
    if (!res.ok) { const e = new Error(`GET ${url} -> ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }
  async function paged(url) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const sep = url.includes('?') ? '&' : '?';
      const items = await json(`${url}${sep}page=${page}`);
      if (!Array.isArray(items)) throw new Error(`unexpected response for ${url}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
  async function raw(repoFull, filePath, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const res = await get(`/repos/${repoFull}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}${q}`, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (!res.ok) { const e = new Error(`GET contents ${repoFull}/${filePath} -> ${res.status}`); e.status = res.status; throw e; }
    return res.text();
  }
  return { json, paged, raw };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function discoverGames(gh, config, warnings) {
  const d = config.discovery || {};
  const repos = await gh.paged(`/orgs/${config.org}/repos?type=all&per_page=100`);
  const exclude = new Set((config.exclude || []).map((s) => s.toLowerCase()));
  const include = new Set((config.include || []).map((s) => s.toLowerCase()));
  const games = [];
  const candidates = [];
  for (const r of repos) {
    const name = r.name.toLowerCase();
    if (include.has(name)) { candidates.push({ r, forced: true }); continue; }
    if (exclude.has(name)) continue;
    if (d.skip_archived && r.archived) continue;
    if (d.skip_forks && r.fork) continue;
    if (d.skip_templates && r.is_template) continue;
    if (d.public_only && r.private) continue;
    candidates.push({ r, forced: false });
  }
  await pool(candidates, 6, async ({ r, forced }) => {
    let manifest = null;
    try {
      const txt = await gh.raw(r.full_name, d.manifest_path || 'public/game.json', r.default_branch);
      if (txt != null) { try { manifest = JSON.parse(txt); } catch { warnings.push({ repo: r.full_name, path: d.manifest_path, message: 'game manifest is not valid JSON' }); } }
    } catch (e) { warnings.push({ repo: r.full_name, path: d.manifest_path, message: `cannot read manifest: ${e.message}` }); return; }
    if (manifest == null && !forced) return;
    const ov = config.overrides?.[r.name] || {};
    games.push({
      repo: r.full_name, slug: (manifest && typeof manifest.slug === 'string' && manifest.slug) || r.name,
      title: ov.title || (manifest && typeof manifest.title === 'string' && manifest.title) || titleFromName(r.name),
      repo_url: r.html_url || `https://github.com/${r.full_name}`,
      url: ov.url || r.homepage || null, report_count: 0, _branch: r.default_branch,
    });
  });
  return games;
}

async function collectRepoReports(gh, game, warnings) {
  const found = [];
  let tree;
  try { tree = await gh.json(`/repos/${game.repo}/git/trees/${encodeURIComponent(game._branch)}?recursive=1`); }
  catch (e) {
    if (e.status === 404 || e.status === 409) return found; // empty repo / no branch
    warnings.push({ repo: game.repo, path: null, message: `cannot list repository tree: ${e.message}` });
    return found;
  }
  if (tree.truncated) warnings.push({ repo: game.repo, path: null, message: 'repository tree was truncated; some reports may be missing' });
  const paths = (tree.tree || []).filter((t) => t.type === 'blob' && /^\.ai-usage\/[^/]+\.json$/.test(t.path)).map((t) => t.path).sort();
  await pool(paths, 6, async (p) => {
    try {
      const txt = await gh.raw(game.repo, p, game._branch);
      if (txt == null) { warnings.push({ repo: game.repo, path: p, message: 'report file not found' }); return; }
      found.push({ repo: game.repo, path: p, text: txt });
    } catch (e) { warnings.push({ repo: game.repo, path: p, message: `cannot fetch report: ${e.message}` }); }
  });
  return found;
}

function localReports(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ repo: null, path: `local:${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Public payload intentionally contains only game-level totals. Never expose
// source report IDs, task names, model/agent identities, timestamps or raw rows.
export function buildOutput({ config, games, rawReports, warnings }) {
  const byRepo = new Map(games.map((g) => [g.repo.toLowerCase(), g]));
  const accepted = new Map();
  for (const item of rawReports) {
    let report;
    try { report = JSON.parse(item.text); } catch { warnings.push({ message: 'invalid JSON report' }); continue; }
    const errs = validateReport(report);
    if (errs.length) { warnings.push({ message: 'rejected report: invalid or legacy schema' }); continue; }
    const actualRepo = (item.repo || report.repo).toLowerCase();
    if (report.repo.toLowerCase() !== actualRepo) { warnings.push({ message: 'rejected report: repository mismatch' }); continue; }
    const game = byRepo.get(actualRepo);
    if (!game) { warnings.push({ message: 'rejected report: unlisted game' }); continue; }
    const key = actualRepo + ':' + report.report_id;
    // Duplicates are never additive; the first matching opaque UUID wins.
    if (accepted.has(key)) { warnings.push({ message: 'ignored duplicate opaque report' }); continue; }
    accepted.set(key, { report, game });
  }

  const totals = new Map();
  for (const g of games) totals.set(g.repo, {
    processed_tokens: 0, noncached_output_tokens: 0, processedKnown: 0, ncoKnown: 0,
    complete: true, hasReports: false,
  });
  for (const { report, game } of accepted.values()) {
    const t = totals.get(game.repo);
    t.hasReports = true;
    if (report.accuracy !== 'exact' || !report.models.length) t.complete = false;
    for (const m of report.models) {
      const n = normalizeModelRow(m);
      const processed = processedTokens(n), nco = nonCachedPlusOutput(n);
      if (processed === null) t.complete = false;
      else { t.processed_tokens += processed; t.processedKnown++; }
      if (nco === null) t.complete = false;
      else { t.noncached_output_tokens += nco; t.ncoKnown++; }
    }
  }
  return {
    schema: 'game-ai-usage/usage@2',
    games: games.map((g) => {
      const t = totals.get(g.repo);
      return {
        title: g.title,
        slug: g.slug,
        processed_tokens: t.processedKnown ? t.processed_tokens : null,
        noncached_output_tokens: t.ncoKnown ? t.noncached_output_tokens : null,
        complete: t.hasReports && t.complete,
      };
    }).sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export async function aggregate({ fetchImpl = globalThis.fetch, config, pricing, token = null, localDir = null, now = () => new Date() }) {
  const warnings = [];
  const gh = makeClient(fetchImpl, token);
  const games = await discoverGames(gh, config, warnings);
  const rawReports = [];
  const perRepo = await pool(games, 4, (g) => collectRepoReports(gh, g, warnings));
  for (const list of perRepo) rawReports.push(...list);
  if (localDir) rawReports.push(...localReports(localDir));
  return buildOutput({ config, pricing, games, rawReports, warnings, generatedAt: now().toISOString() });
}

// Writes the file only when something other than generated_at changed. Returns true if written.
export function writeIfChanged(outPath, data) {
  const strip = (o) => JSON.stringify({ ...o, generated_at: null });
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (strip(prev) === strip(data)) return false;
  } catch { /* no previous file */ }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

async function main() {
  const { values: a } = parseArgs({ options: { out: { type: 'string' }, 'local-reports': { type: 'string' }, config: { type: 'string' }, pricing: { type: 'string' } } });
  const config = JSON.parse(fs.readFileSync(a.config || path.join(ROOT, 'config/games.json'), 'utf8'));
  const pricing = JSON.parse(fs.readFileSync(a.pricing || path.join(ROOT, 'pricing.json'), 'utf8'));
  const token = getToken();
  if (!token) console.warn('aggregate: no GitHub token found (GITHUB_TOKEN/GH_TOKEN/gh auth); using unauthenticated API (rate-limited, public repos only)');
  const data = await aggregate({ config, pricing, token, localDir: a['local-reports'] || null });
  const outPath = path.resolve(a.out || path.join(ROOT, 'site/data/usage.json'));
  const changed = writeIfChanged(outPath, data);
  console.log(`${data.games.length} games, ${changed ? 'wrote' : 'unchanged:'} ${outPath}; ${data.warnings?.length || 0} warnings`);
  // Raw report errors are never published; do not print report paths or private identifiers.
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error(`aggregate: ${e.stack || e.message}`); process.exit(1); });
}
