#!/usr/bin/env node
// report-usage.mjs - create privacy-safe AI usage reports with opaque IDs
// Standalone, zero dependencies, Node 22+. Never invents numbers: unknown = null.
// Run with --help for usage. Format: https://github.com/procrastinate-games/game-ai-usage/blob/main/agent-kit/report.schema.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPORTER = 'report-usage.mjs@1';
const SCHEMA = 'game-ai-usage/report@2';
const AGENTS = ['claude-code', 'codex', 'codex-cloud', 'gemini-cli', 'other'];
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const NUM_FIELDS = [...TOKEN_FIELDS, 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'reasoning_tokens', 'calls'];

const HELP = `Usage: node report-usage.mjs --agent <claude-code|codex|codex-cloud|gemini-cli|other> [options]

Modes (pick by agent; --unknown / --manual override):
  claude-code   reads ~/.claude/projects/<cwd-dir>/<session>.jsonl (+ subagents)
  codex         reads ~/.codex/sessions/**/rollout-*.jsonl[.zst]
  gemini-cli    reads ~/.gemini/tmp/*/chats/session-*.json (best effort, unverified format)
  --unknown     no token access (e.g. Codex Cloud): writes a report with all tokens null
  --manual      values you actually observed: --provider --model --input --output
                --cache-read --cache-write [--cache-write-5m --cache-write-1h]
                --accuracy exact|partial --source agent-self-report|manual

Options:
  --session <id|prefix|suffix>   --transcript <path>   --rollout <path> (repeatable)   --chat <path>
  --projects-dir <dir>    --codex-home <dir>    --gemini-home <dir>
  --repo owner/name (default: git remote origin)\n  --session selects a local log ONLY; its real ID is never committed.
  --out <dir>             default: <git root>/.ai-usage
  --dry-run               print JSON to stdout, write nothing
  --help
Exit code is non-zero (and nothing is written) if no usage data is found.`;

function die(msg, code = 1) { process.stderr.write(`report-usage: ${msg}\n`); process.exit(code); }
const warn = (m) => process.stderr.write(`report-usage: warning: ${m}\n`);

// ── tier thresholds (embedded; keep in sync with pricing.json) ─────────────
export function canonicalModelId(model) {
  if (!model) return model;
  return String(model).trim().toLowerCase().replace(/-(\d{8})$/, '').replace(/@\d{8}$/, '');
}
// Returns threshold in tokens or null when the model has no tiered pricing.
export function tierThreshold(model) {
  const id = canonicalModelId(model);
  if (!id) return null;
  if (id === 'claude-haiku-5-5') return 100000;
  if (id.startsWith('gpt-6') || id.startsWith('gpt-5.6') || id === 'gpt-5.5' || id === 'gpt-5.4') return 272000;
  if (id === 'gemini-3.1-pro-preview' || id === 'gemini-2.5-pro') return 200000;
  return null;
}
const tierFor = (model, promptTokens) => {
  const t = tierThreshold(model);
  if (t == null) return null;
  return promptTokens > t ? 'long' : 'base';
};

// ── helpers ────────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const n0 = (v) => (isNum(v) && v > 0 ? v : 0);
const isoOrNull = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const utcDate = (iso) => iso.slice(0, 10);
const addIf = (a, b) => (a == null || b == null ? null : a + b);

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}
export function parseRepoUrl(url) {
  const m = String(url).trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
function detectRepo(cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseRepoUrl(url);
  } catch { return null; }
}

function readLines(file) {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error(`cannot read ${file}: this Node has no zstd support (need Node 22.15+)`);
    buf = zlib.zstdDecompressSync(buf);
  }
  return buf.toString('utf8').split('\n');
}
function* jsonLines(file) {
  for (const line of readLines(file)) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* skip partial/corrupt line */ }
  }
}
function walk(dir, pred, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
  return out;
}
const mtime = (f) => fs.statSync(f).mtimeMs;

// Row accumulator keyed by model|tier. Fields start at 0; a null marks "unknown".
function addRow(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

// ── claude-code ────────────────────────────────────────────────────────────
function claudeProjectDirName(cwd) { return cwd.replace(/[/.]/g, '-'); }

function findClaudeTranscript(a, cwd) {
  if (a.transcript) {
    if (!fs.existsSync(a.transcript)) die(`transcript not found: ${a.transcript}`);
    return a.transcript;
  }
  const root = a['projects-dir'] || path.join(os.homedir(), '.claude', 'projects');
  const projDir = path.join(root, claudeProjectDirName(cwd));
  const listJsonl = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)) : []);
  // Claude Code exports the running session's id to tool shells; prefer it over guessing.
  const session = a.session || process.env.CLAUDE_CODE_SESSION_ID;
  if (session && !a.session) a.session = session;
  if (a.session) {
    let c = listJsonl(projDir).filter((f) => path.basename(f).startsWith(a.session));
    if (!c.length) c = walk(root, (n) => n.endsWith('.jsonl')).filter((f) => path.basename(f).startsWith(a.session) && !f.includes(`${path.sep}subagents${path.sep}`));
    if (!c.length) die(`no Claude transcript matching session "${a.session}" under ${root}`);
    if (c.length > 1) die(`session prefix "${a.session}" is ambiguous: ${c.map((f) => path.basename(f)).join(', ')}`);
    return c[0];
  }
  // Sessions are often started in a parent folder of the game repo: walk up the directory tree.
  let c = [];
  for (let d = cwd; !c.length; d = path.dirname(d)) {
    c = listJsonl(path.join(root, claudeProjectDirName(d))).sort((x, y) => mtime(y) - mtime(x));
    if (d === path.dirname(d)) break;
  }
  if (!c.length) die(`no Claude transcripts for cwd ${cwd} or its parents under ${root} (use --transcript or --session)`);
  return c[0];
}

export function collectClaude(transcript) {
  const sid = path.basename(transcript).replace(/\.jsonl$/, '');
  const files = [transcript];
  const subdir = path.join(path.dirname(transcript), sid, 'subagents');
  if (fs.existsSync(subdir)) for (const f of fs.readdirSync(subdir).sort()) if (f.endsWith('.jsonl')) files.push(path.join(subdir, f));

  const msgs = new Map(); // message id -> last usage seen
  let skippedLines = 0;
  const skippedMsgs = new Set();
  let first = null, last = null, version = null;
  for (const file of files) {
    for (const j of jsonLines(file)) {
      if (j.sessionId && j.sessionId !== sid) {
        if (j.type === 'assistant' && j.message?.usage) { skippedLines++; skippedMsgs.add(j.message.id || j.uuid); }
        continue;
      }
      if (j.timestamp) {
        const t = isoOrNull(j.timestamp);
        if (t) { if (!first || t < first) first = t; if (!last || t > last) last = t; }
      }
      if (j.version && file === transcript) version = j.version;
      const m = j.message;
      if (j.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
      msgs.set(m.id || j.uuid, { u: m.usage, model: m.model });
    }
  }
  const rows = new Map();
  for (const { u, model } of msgs.values()) {
    const inp = n0(u.input_tokens), out = n0(u.output_tokens), cr = n0(u.cache_read_input_tokens), cw = n0(u.cache_creation_input_tokens);
    const tier = tierFor(model, inp + cr + cw);
    const r = addRow(rows, `${model}|${tier}`, () => ({
      provider: model.startsWith('claude') ? 'anthropic' : 'other', model, price_tier: tier, calls: 0,
      input_tokens: 0, output_tokens: 0, reasoning_tokens: null, cache_read_tokens: 0, cache_write_tokens: 0,
      cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    }));
    r.calls++; r.input_tokens += inp; r.output_tokens += out; r.cache_read_tokens += cr; r.cache_write_tokens += cw;
    const c = u.cache_creation;
    const a5 = c?.ephemeral_5m_input_tokens, a1 = c?.ephemeral_1h_input_tokens;
    const known = c && (isNum(a5) || isNum(a1)) && n0(a5) + n0(a1) === cw;
    if (known && r.cache_write_5m_tokens != null) { r.cache_write_5m_tokens += n0(a5); r.cache_write_1h_tokens += n0(a1); }
    else if (cw > 0 || !known) {
      // a message without cache writes (cw = 0) needs no split; otherwise the split is unknown
      if (cw > 0) { r.cache_write_5m_tokens = null; r.cache_write_1h_tokens = null; }
    }
  }
  if (!msgs.size) return null;
  let notes = '';
  if (skippedLines) notes = `Skipped ${skippedLines} assistant lines (${skippedMsgs.size} messages) copied from a parent session (fork/resume); only this session's own lines are counted.`;
  return { sessionId: sid, started_at: first, ended_at: last, agent_version: version, rows: [...rows.values()], notes, accuracy: 'exact', source: 'claude-code-transcript',
    summary: `${files.length - 1} subagent file(s)` };
}

// ── codex ──────────────────────────────────────────────────────────────────
function readFirstLine(file) {
  if (file.endsWith('.zst')) return readLines(file)[0];
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const i = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, i >= 0 ? i : n)));
      if (i >= 0) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function codexMeta(file) {
  try {
    const o = JSON.parse(readFirstLine(file));
    if (o.type !== 'session_meta' || !o.payload) return null;
    const p = o.payload;
    return { file, id: p.id || null, session: p.session_id || p.id || null, cwd: p.cwd || null, timestamp: p.timestamp || o.timestamp || null, version: p.cli_version || null };
  } catch { return null; }
}
const inside = (child, parent) => child && (child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/'));
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const stableKey = (o) => JSON.stringify(FIELDS.map((f) => n0(o[f])).concat([n0(o.total_tokens)]));

export function collectCodex(a, gitroot) {
  let metas;
  if (a.rollout?.length) {
    metas = a.rollout.map((f) => { if (!fs.existsSync(f)) die(`rollout not found: ${f}`); return codexMeta(f) || die(`not a Codex rollout (no session_meta): ${f}`); });
  } else {
    const home = a['codex-home'] || path.join(os.homedir(), '.codex');
    const all = walk(path.join(home, 'sessions'), (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n)).sort((x, y) => mtime(y) - mtime(x));
    if (!all.length) return null;
    let chosen;
    if (a.session) {
      const hits = [];
      for (const f of all) { const m = codexMeta(f); if (m && ((m.id && m.id.includes(a.session)) || (m.session && m.session.includes(a.session)))) hits.push(m); }
      if (!hits.length) die(`no Codex rollout matching session "${a.session}" in ${home}/sessions`);
      const ids = new Set(hits.map((m) => m.session));
      if (ids.size > 1) die(`session prefix "${a.session}" is ambiguous (${[...ids].join(', ')})`);
      chosen = hits[0].session;
    } else {
      if (!gitroot) die('cannot pick a default Codex session outside a git repo; pass --session or --rollout');
      for (const f of all) { const m = codexMeta(f); if (m && inside(m.cwd, gitroot)) { chosen = m.session; break; } }
      if (!chosen) die(`no Codex rollout with cwd inside ${gitroot}; pass --session or --rollout`);
    }
    metas = all.map(codexMeta).filter((m) => m && m.session === chosen);
  }
  const sessionId = metas.find((m) => m.session)?.session;
  if (!sessionId) die('rollout has no session id');
  metas = metas.filter((m) => m.session === sessionId || a.rollout?.length)
    .sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)) || x.file.localeCompare(y.file));

  const seen = new Set();
  const rows = new Map();
  let first = null, last = null, version = null, skippedNeg = 0, dupEvents = 0, nEvents = 0;
  const bump = (iso) => { const t = isoOrNull(iso); if (t) { if (!first || t < first) first = t; if (!last || t > last) last = t; } };
  for (const meta of metas) {
    if (!version && meta.version) version = meta.version;
    bump(meta.timestamp);
    let model = null, prev = null, isFirst = true;
    for (const o of jsonLines(meta.file)) {
      if (o.timestamp) bump(o.timestamp);
      if (o.type === 'turn_context' && o.payload?.model) { model = o.payload.model; continue; }
      if (o.type !== 'event_msg' || o.payload?.type !== 'token_count' || !o.payload.info?.total_token_usage) continue;
      nEvents++;
      const cur = o.payload.info.total_token_usage;
      const lastU = o.payload.info.last_token_usage;
      const key = stableKey(cur);
      let delta = null;
      if (isFirst) {
        isFirst = false;
        if (seen.has(key)) { dupEvents++; delta = null; }
        else if (lastU) delta = Object.fromEntries(FIELDS.map((f) => [f, n0(lastU[f])]));
        else warn(`first token_count in ${path.basename(meta.file)} has no last_token_usage; skipped`);
      } else if (seen.has(key)) {
        dupEvents++;
      } else {
        const d = Object.fromEntries(FIELDS.map((f) => [f, n0(cur[f]) - n0(prev[f])]));
        if (FIELDS.some((f) => d[f] < 0)) skippedNeg++;
        else if (d.input_tokens + d.output_tokens > 0) delta = d;
      }
      seen.add(key);
      prev = cur;
      if (!delta || delta.input_tokens + delta.output_tokens <= 0) continue;
      const tier = tierFor(model, n0(lastU?.input_tokens ?? delta.input_tokens));
      const r = addRow(rows, `${model}|${tier}`, () => ({
        provider: 'openai', model, price_tier: tier, calls: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, cache_write_5m_tokens: null, cache_write_1h_tokens: null, _cw: false,
      }));
      r.calls++;
      r.input_tokens += delta.input_tokens - delta.cached_input_tokens - delta.cache_write_input_tokens;
      r.cache_read_tokens += delta.cached_input_tokens;
      r.cache_write_tokens += delta.cache_write_input_tokens;
      r.output_tokens += delta.output_tokens;
      r.reasoning_tokens += delta.reasoning_output_tokens;
      if (delta.cache_write_input_tokens > 0) r._cw = true;
    }
  }
  if (!rows.size) return null;
  let accuracy = 'exact';
  const notes = [];
  for (const r of rows.values()) {
    if (r._cw) {
      r.input_tokens = null; r.cache_write_tokens = null; accuracy = 'partial';
      notes.push(`Codex reported cache_write_input_tokens > 0 for ${r.model}; its semantics are not verified, so input_tokens and cache_write_tokens are null.`);
    }
    delete r._cw;
  }
  if (skippedNeg) { accuracy = 'partial'; notes.push(`${skippedNeg} token_count event(s) had a decreasing cumulative counter and were skipped.`); }
  if ([...rows.values()].some((r) => r.model == null)) { accuracy = 'partial'; notes.push('Some usage could not be attributed to a model (no turn_context seen).'); }
  const root = metas[0];
  return { sessionId, started_at: first, ended_at: last, agent_version: version || root.version, rows: [...rows.values()], notes: [...new Set(notes)].join(' '), accuracy, source: 'codex-rollout',
    summary: `${metas.length} rollout file(s), ${nEvents} token_count events (${dupEvents} duplicates ignored)` };
}

// ── gemini-cli (best effort, unverified format) ────────────────────────────
function findGeminiChat(a, cwd, gitroot) {
  if (a.chat) { if (!fs.existsSync(a.chat)) die(`chat file not found: ${a.chat}`); return a.chat; }
  const home = a['gemini-home'] || path.join(os.homedir(), '.gemini');
  const tmp = path.join(home, 'tmp');
  const all = walk(tmp, (n) => /^session-.*\.json$/.test(n)).filter((f) => f.includes(`${path.sep}chats${path.sep}`));
  if (a.session) {
    const hits = all.filter((f) => path.basename(f).includes(a.session) || (() => { try { return String(JSON.parse(fs.readFileSync(f, 'utf8')).sessionId || '').startsWith(a.session); } catch { return false; } })());
    if (!hits.length) die(`no Gemini chat matching "${a.session}" under ${tmp}`);
    return hits.sort((x, y) => mtime(y) - mtime(x))[0];
  }
  const hashes = [...new Set([cwd, gitroot].filter(Boolean).map((p) => crypto.createHash('sha256').update(p).digest('hex')))];
  const mine = all.filter((f) => hashes.some((h) => f.includes(`${path.sep}${h}${path.sep}`))).sort((x, y) => mtime(y) - mtime(x));
  if (!mine.length) die('no Gemini chats found for this project; pass --chat or --session');
  return mine[0];
}
export function collectGemini(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`cannot parse ${file}: ${e.message}`); }
  const msgs = (doc.messages || []).filter((m) => m && m.type === 'gemini' && m.tokens);
  if (!msgs.length) return null;
  const rows = new Map(); const ids = new Set();
  let accuracy = 'exact'; const notes = []; let mismatch = 0, bad = 0;
  let first = isoOrNull(doc.startTime), last = isoOrNull(doc.lastUpdated);
  for (const m of msgs) {
    if (m.id) { if (ids.has(m.id)) continue; ids.add(m.id); }
    const t = m.tokens;
    const input = n0(t.input), output = n0(t.output), cached = n0(t.cached), thoughts = n0(t.thoughts), tool = n0(t.tool);
    if (isNum(t.total) && t.total !== input + output + thoughts + tool) mismatch++;
    if (cached > input) bad++;
    const model = m.model || null;
    const tier = tierFor(model, input + tool);
    const r = addRow(rows, `${model}|${tier}`, () => ({
      provider: 'google', model, price_tier: tier, calls: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cache_write_5m_tokens: null, cache_write_1h_tokens: null,
    }));
    r.calls++;
    r.input_tokens += Math.max(0, input - cached) + tool;
    r.cache_read_tokens += cached;
    r.output_tokens += output + thoughts;
    r.reasoning_tokens += thoughts;
    const ts = isoOrNull(m.timestamp);
    if (ts) { if (!first || ts < first) first = ts; if (!last || ts > last) last = ts; }
  }
  if (mismatch) { accuracy = 'partial'; notes.push(`${mismatch} message(s) where tokens.total != input+output+thoughts+tool.`); }
  if (bad) { accuracy = 'partial'; notes.push(`${bad} message(s) with cached > input.`); }
  notes.push('Gemini CLI session format is unverified; counts are best effort.');
  const sid = String(doc.sessionId || path.basename(file).replace(/\.json$/, ''));
  return { sessionId: sid, started_at: first, ended_at: last, agent_version: null, rows: [...rows.values()], notes: notes.join(' '), accuracy, source: 'gemini-cli-session', summary: `${ids.size || msgs.length} message(s)` };
}

// ── unknown / manual ───────────────────────────────────────────────────────
const DEFAULT_PROVIDER = { 'codex-cloud': 'openai', codex: 'openai', 'claude-code': 'anthropic', 'gemini-cli': 'google' };
const nullRow = (provider, model) => ({ provider, model, price_tier: null, calls: null, input_tokens: null, output_tokens: null, reasoning_tokens: null,
  cache_read_tokens: null, cache_write_tokens: null, cache_write_5m_tokens: null, cache_write_1h_tokens: null });

function parseCount(name, v) {
  if (v == null) return null;
  if (!/^\d+$/.test(String(v).trim())) die(`--${name} must be a non-negative integer (got "${v}")`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) die(`--${name} is too large`);
  return n;
}

// The source session id only appears in the private .git mapping, never in reports.
export function getOpaqueReportId(gitroot, sourceKey, dryRun = false) {
  if (dryRun || !gitroot) return crypto.randomUUID();
  let dir;
  try {
    dir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {cwd: gitroot, encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
  } catch { return crypto.randomUUID(); }
  const file=path.join(dir,'game-ai-usage-private-index.json');
  let db;
  try { db=JSON.parse(fs.readFileSync(file,'utf8')); } catch { db=null; }
  if (!db || !/^[a-f0-9]{64}$/.test(db.secret||'') || typeof db.ids!=='object') db={secret:crypto.randomBytes(32).toString('hex'),ids:{}};
  const key=crypto.createHmac('sha256',Buffer.from(db.secret,'hex')).update(sourceKey).digest('hex');
  if (!db.ids[key]) {
    db.ids[key]=crypto.randomUUID();
    fs.writeFileSync(file,JSON.stringify(db),{mode:0o600});
    fs.chmodSync(file,0o600);
  }
  return db.ids[key];
}

// ── validation (minimal mirror of site/lib/accounting.js validateReport) ───
export function selfValidate(r) {
  const errs = [];
  if (r.schema !== SCHEMA) errs.push('wrong schema');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.report_id || '')) errs.push('report_id is not an opaque UUID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) errs.push('bad date');
  const allowed = ['schema', 'report_id', 'repo', 'date', 'accuracy', 'models'];
  for (const key of Object.keys(r)) if (!allowed.includes(key)) errs.push('forbidden metadata: ' + key);
  r.models.forEach((m, i) => {
    for (const f of NUM_FIELDS) if (m[f] != null && !(Number.isInteger(m[f]) && m[f] >= 0)) errs.push(`models[${i}].${f} invalid`);
  });
  if (r.accuracy === 'exact' && !(r.models.length && r.models.every((m) => TOKEN_FIELDS.every((f) => isNum(m[f]))))) errs.push('exact requires all token fields');
  if (r.accuracy === 'unknown' && r.models.some((m) => TOKEN_FIELDS.some((f) => isNum(m[f])))) errs.push('unknown must not carry token numbers');
  return errs;
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        agent: { type: 'string' }, session: { type: 'string' }, transcript: { type: 'string' }, rollout: { type: 'string', multiple: true },
        chat: { type: 'string' }, 'projects-dir': { type: 'string' }, 'codex-home': { type: 'string' }, 'gemini-home': { type: 'string' },
        task: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' },
        unknown: { type: 'boolean' }, manual: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
        input: { type: 'string' }, output: { type: 'string' }, 'cache-read': { type: 'string' }, 'cache-write': { type: 'string' },
        'cache-write-5m': { type: 'string' }, 'cache-write-1h': { type: 'string' }, accuracy: { type: 'string' }, source: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (e) { die(`${e.message}\n\n${HELP}`, 2); }
  const a = parsed.values;
  if (a.help) { process.stdout.write(HELP + '\n'); return; }
  if (!a.agent || !AGENTS.includes(a.agent)) die(`--agent is required and must be one of ${AGENTS.join(', ')}`, 2);
  if (a.unknown && a.manual) die('--unknown and --manual are mutually exclusive', 2);

  const cwd = process.cwd();
  const gitroot = gitRoot(cwd);
  const repo = a.repo || detectRepo(cwd);
  if (a.repo && !/^[\w.-]+\/[\w.-]+$/.test(a.repo)) die('--repo must look like owner/name', 2);
  if (!repo && !a['dry-run']) die('cannot determine repository (no git remote "origin"); pass --repo owner/name');
  if (!repo) warn('repository unknown (dry run); "repo" will be null');
  const nowIso = new Date().toISOString();

  let data;
  if (a.unknown) {
    const sid = a.session || `unknown-${nowIso.replace(/\D/g, '').slice(0, 14)}`;
    if (!a.session) warn(`no --session given; using generated id "${sid}" (re-reporting will create another report)`);
    data = { sessionId: sid, started_at: null, ended_at: null, agent_version: null, rows: [nullRow(a.provider || DEFAULT_PROVIDER[a.agent] || 'other', a.model || null)],
      notes: 'Token usage is not available to this agent.', accuracy: 'unknown', source: 'unavailable', summary: 'tokens unknown' };
  } else if (a.manual) {
    if (!a.provider) die('--manual requires --provider', 2);
    const row = nullRow(a.provider, a.model || null);
    row.input_tokens = parseCount('input', a.input);
    row.output_tokens = parseCount('output', a.output);
    row.cache_read_tokens = parseCount('cache-read', a['cache-read']);
    row.cache_write_tokens = parseCount('cache-write', a['cache-write']);
    row.cache_write_5m_tokens = parseCount('cache-write-5m', a['cache-write-5m']);
    row.cache_write_1h_tokens = parseCount('cache-write-1h', a['cache-write-1h']);
    if (row.cache_write_5m_tokens != null && row.cache_write_1h_tokens != null) {
      const s = row.cache_write_5m_tokens + row.cache_write_1h_tokens;
      if (row.cache_write_tokens != null && row.cache_write_tokens !== s) die('--cache-write must equal --cache-write-5m + --cache-write-1h');
      row.cache_write_tokens ??= s;
    }
    const acc = a.accuracy || 'partial';
    if (!['exact', 'partial'].includes(acc)) die('--accuracy must be exact or partial for --manual', 2);
    const src = a.source || 'agent-self-report';
    if (!['agent-self-report', 'manual'].includes(src)) die('--source must be agent-self-report or manual', 2);
    if (TOKEN_FIELDS.every((f) => row[f] == null)) die('--manual needs at least one token number (use --unknown if you have none)');
    if (acc === 'exact' && !TOKEN_FIELDS.every((f) => row[f] != null)) die('--accuracy exact requires --input --output --cache-read --cache-write; otherwise use partial');
    const sid = a.session || `manual-${nowIso.replace(/\D/g, '').slice(0, 14)}`;
    if (!a.session) warn(`no --session given; using generated id "${sid}"`);
    data = { sessionId: sid, started_at: null, ended_at: null, agent_version: null, rows: [row], notes: 'Values were reported by the agent/user, not read from logs.', accuracy: acc, source: src, summary: 'manual values' };
  } else if (a.agent === 'claude-code') {
    const t = findClaudeTranscript(a, cwd);
    data = collectClaude(t);
    if (!data) die(`no assistant usage found in ${t}`);
  } else if (a.agent === 'codex') {
    data = collectCodex(a, gitroot);
    if (!data) die('no Codex token_count usage found');
  } else if (a.agent === 'gemini-cli') {
    const f = findGeminiChat(a, cwd, gitroot);
    data = collectGemini(f);
    if (!data) die(`no Gemini token usage found in ${f}`);
  } else {
    die(`agent "${a.agent}" has no log reader; use --unknown or --manual`);
  }

  const endedAt = data.ended_at || null;
  const date = utcDate(endedAt || nowIso);
  const report = {
    schema: SCHEMA,
    report_id: getOpaqueReportId(gitroot, `${a.agent}:${data.sessionId}`, !!a['dry-run']),
    repo,
    date,
    accuracy: data.accuracy,
    models: data.rows.map((r) => Object.fromEntries(['provider', 'model', 'price_tier', 'calls', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens'].map((k) => [k, r[k] ?? null]))),
  };
  const errs = selfValidate(report);
  if (errs.length) die(`internal error, refusing to write invalid report: ${errs.join('; ')}`);

  // human summary
  const err = (s) => process.stderr.write(s + '\n');
  err(`${a.agent}: usage report (${report.date}); accuracy ${report.accuracy}`);
  for (const m of report.models) {
    const tot = TOKEN_FIELDS.every((f) => m[f] != null) ? TOKEN_FIELDS.reduce((s, f) => s + m[f], 0) : null;
    err(`  ${m.model ?? '(unknown model)'}${m.price_tier ? ` [${m.price_tier}]` : ''}: calls ${m.calls ?? '?'}, in ${m.input_tokens ?? '?'}, out ${m.output_tokens ?? '?'}, cache read ${m.cache_read_tokens ?? '?'}, cache write ${m.cache_write_tokens ?? '?'}, processed ${tot ?? '?'}`);
  }
  // Never publish raw log notes: they may include private session metadata.

  const json = JSON.stringify(report, null, 2) + '\n';
  if (a['dry-run']) { process.stdout.write(json); return; }

  const outDir = path.resolve(a.out || (gitroot ? path.join(gitroot, '.ai-usage') : die('not in a git repo; pass --out <dir>')));
  fs.mkdirSync(outDir, { recursive: true });
  const name = `usage-${report.report_id}.json`;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.json') || f === name) continue;
    try {
      if (JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')).report_id === report.report_id) {
        fs.unlinkSync(path.join(outDir, f));
        err(`  removed older snapshot ${f}`);
      }
    } catch { /* not ours */ }
  }
  // Refuse new reports while legacy sensitive reports remain in the output directory.
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.json') || f === name) continue;
    try {
      const old = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      if (old.schema !== SCHEMA) die('legacy usage report detected; remove or migrate it before committing new reports');
    } catch (e) {
      if (e?.message?.includes('legacy usage report')) throw e;
    }
  }
  fs.writeFileSync(path.join(outDir, name), json);
  err(`wrote ${path.join(outDir, name)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
