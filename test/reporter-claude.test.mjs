import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateReport } from '../site/lib/accounting.js';
import { runReporter, rowOf, FIX } from './helpers.mjs';

const T = path.join(FIX, 'claude', 'aaaa1111-0000-4000-8000-000000000001.jsonl');
const run = () => runReporter(['--agent', 'claude-code', '--transcript', T, '--repo', 'procrastinate-games/circuit-runner', '--dry-run', '--task', 'fixture']);

test('claude-code reporter: dedup, subagents, fork filter, synthetic, split handling', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const rep = r.json;
  assert.deepEqual(validateReport(rep), []);
  assert.match(rep.report_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(rep.session_id, undefined);
  assert.equal(rep.task, undefined);
  assert.equal(rep.started_at, undefined);
  assert.equal(rep.ended_at, undefined);
  assert.equal(rep.accuracy, 'exact');
  assert.equal(rep.source, undefined);
  assert.equal(rep.date, '2026-11-12');

  const opus = rowOf(rep, 'claude-opus-5-5');
  // m1 (last streaming line wins), m2, m4 (subagent); synthetic and foreign-session lines excluded
  assert.equal(opus.calls, 3);
  assert.equal(opus.input_tokens, 22);
  assert.equal(opus.output_tokens, 290);
  assert.equal(opus.cache_read_tokens, 1800);
  assert.equal(opus.cache_write_tokens, 50);
  assert.equal(opus.cache_write_5m_tokens, 0);
  assert.equal(opus.cache_write_1h_tokens, 50);
  assert.equal(opus.provider, 'anthropic');

  const sonnet = rowOf(rep, 'claude-sonnet-5-5');
  assert.equal(sonnet.cache_write_tokens, 30);
  assert.equal(sonnet.cache_write_5m_tokens, null);
  assert.equal(sonnet.cache_write_1h_tokens, null);

  assert.equal(rep.notes, undefined);
  assert.equal(rep.models.some((m) => m.model === '<synthetic>'), false);
});

test('claude-code reporter: tiered model is split by per-request prompt size', () => {
  const rep = run().json;
  const base = rowOf(rep, 'claude-haiku-5-5', 'base');
  const long = rowOf(rep, 'claude-haiku-5-5', 'long');
  assert.equal(base.calls, 1);
  assert.equal(base.cache_read_tokens, 40);
  assert.equal(long.calls, 1);
  assert.equal(long.cache_read_tokens, 149990);
  assert.equal(rowOf(rep, 'claude-opus-5-5').price_tier, null);
});

test('claude-code reporter: no data -> non-zero exit, nothing printed', () => {
  const r = runReporter(['--agent', 'claude-code', '--transcript', path.join(FIX, 'claude', 'nope.jsonl'), '--repo', 'a/b', '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});
