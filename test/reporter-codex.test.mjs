import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { validateReport } from '../site/lib/accounting.js';
import { runReporter, rowOf, FIX } from './helpers.mjs';

const home = path.join(FIX, 'codex');
const args = ['--agent', 'codex', '--codex-home', home, '--repo', 'a/b', '--dry-run'];

test('codex reporter: shared cumulative counter across child thread, duplicate event ignored', () => {
  const r = runReporter([...args, '--session', 'root']);
  assert.equal(r.status, 0, r.stderr);
  const rep = r.json;
  assert.deepEqual(validateReport(rep), []);
  assert.match(rep.report_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(rep.session_id, undefined);
  assert.equal(rep.accuracy, 'exact');

  const base = rowOf(rep, 'gpt-6.1-sol', 'base');
  assert.equal(base.calls, 2);
  assert.equal(base.input_tokens, 1600);       // (1000-400) + (2000-1000)
  assert.equal(base.cache_read_tokens, 1400);
  assert.equal(base.output_tokens, 300);
  assert.equal(base.reasoning_tokens, 80);
  assert.equal(base.cache_write_tokens, 0);

  const long = rowOf(rep, 'gpt-6.1-sol', 'long');
  assert.equal(long.calls, 1);
  assert.equal(long.input_tokens, 200000);
  assert.equal(long.cache_read_tokens, 100000);
  assert.equal(long.output_tokens, 100);

  // child file: first event equals the parent's last cumulative -> baseline only; second adds its delta once
  const child = rowOf(rep, 'codex-auto-review');
  assert.equal(child.calls, 1);
  assert.equal(child.input_tokens, 400);
  assert.equal(child.cache_read_tokens, 100);
  assert.equal(child.output_tokens, 50);

  // total processed = final cumulative counter (303500 input incl. cached + 450 output), NOT sum of per-file finals
  const total = rep.models.reduce((s, m) => s + m.input_tokens + m.cache_read_tokens + m.cache_write_tokens + m.output_tokens, 0);
  assert.equal(total, 303500 + 450);
  // unrelated session in the same dir is not included
  assert.equal(rep.models.some((m) => m.model === 'gpt-5.5'), false);
});

test('codex reporter: session id suffix match and explicit --rollout', () => {
  const r = runReporter([...args, '--session', '0000root']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.session_id, undefined);
  const f = path.join(home, 'sessions/2026/11/10/rollout-2026-11-10T11-00-00-01bbbbbb-0000-7000-8000-00000other.jsonl');
  const r2 = runReporter(['--agent', 'codex', '--rollout', f, '--repo', 'a/b', '--dry-run']);
  assert.equal(r2.json.models[0].model, 'gpt-5.5');
  assert.equal(r2.json.models[0].input_tokens, 77);
});

test('codex reporter: non-zero cache_write marks input/cache_write null and partial', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cw-'));
  const f = path.join(dir, 'rollout-x.jsonl');
  const tu = { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 105 };
  fs.writeFileSync(f, [
    { type: 'session_meta', payload: { id: 'cw-1', session_id: 'cw-1', timestamp: '2026-11-10T10:00:00Z', cwd: '/x' } },
    { type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
    { timestamp: '2026-11-10T10:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tu, last_token_usage: tu } } },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const r = runReporter(['--agent', 'codex', '--rollout', f, '--repo', 'a/b', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.accuracy, 'partial');
  const m = r.json.models[0];
  assert.equal(m.input_tokens, null);
  assert.equal(m.cache_write_tokens, null);
  assert.equal(m.cache_read_tokens, 10);
  assert.equal(m.output_tokens, 5);
  assert.deepEqual(validateReport(r.json), []);
  assert.equal(r.json.notes, undefined);
});

test('codex reporter: unknown session -> error', () => {
  const r = runReporter([...args, '--session', 'does-not-exist']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});
