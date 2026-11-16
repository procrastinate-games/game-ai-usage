import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { validateReport } from '../site/lib/accounting.js';
import { runReporter, rowOf, FIX } from './helpers.mjs';

test('--unknown report validates and carries no numbers', () => {
  const r = runReporter(['--agent', 'codex-cloud', '--unknown', '--session', 'task_e_42', '--model', 'gpt-6-sol', '--repo', 'a/b', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(validateReport(r.json), []);
  assert.equal(r.json.accuracy, 'unknown');
  assert.equal(r.json.models[0].provider, 'openai');
  assert.equal(r.json.models[0].model, 'gpt-6-sol');
  assert.equal(r.json.models[0].input_tokens, null);
  assert.match(r.json.report_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.ok(!JSON.stringify(r.json).includes('task_e_42'));
});

test('--unknown without --session generates an id and warns', () => {
  const r = runReporter(['--agent', 'gemini-cli', '--unknown', '--repo', 'a/b', '--dry-run']);
  assert.equal(r.status, 0);
  assert.equal(r.json.session_id, undefined);
  assert.equal(r.json.models[0].provider, 'google');
  assert.match(r.stderr, /warning/);
});

test('--manual report validates (partial, then exact)', () => {
  const p = runReporter(['--agent', 'gemini-cli', '--manual', '--provider', 'google', '--model', 'gemini-3.1-pro-preview', '--input', '1000', '--output', '200', '--session', 's1', '--repo', 'a/b', '--dry-run']);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(validateReport(p.json), []);
  assert.equal(p.json.accuracy, 'partial');
  assert.equal(p.json.models[0].cache_read_tokens, null);
  const e = runReporter(['--agent', 'other', '--manual', '--provider', 'other', '--input', '1', '--output', '2', '--cache-read', '3', '--cache-write-5m', '1', '--cache-write-1h', '2', '--accuracy', 'exact', '--source', 'manual', '--session', 's2', '--repo', 'a/b', '--dry-run']);
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(validateReport(e.json), []);
  assert.equal(e.json.models[0].cache_write_tokens, 3);
});

test('invalid numbers and impossible exact reports are refused', () => {
  for (const bad of ['-5', '1.5', 'abc', '1e3']) {
    const r = runReporter(['--agent', 'other', '--manual', '--provider', 'other', '--input', bad, '--session', 's', '--repo', 'a/b', '--dry-run']);
    assert.notEqual(r.status, 0, bad);
    assert.equal(r.stdout, '');
  }
  const r = runReporter(['--agent', 'other', '--manual', '--provider', 'other', '--input', '5', '--accuracy', 'exact', '--session', 's', '--repo', 'a/b', '--dry-run']);
  assert.notEqual(r.status, 0);
  const none = runReporter(['--agent', 'other', '--manual', '--provider', 'other', '--session', 's', '--repo', 'a/b', '--dry-run']);
  assert.notEqual(none.status, 0);
});

test('hand-written Codex Cloud unknown report fixture passes validation', () => {
  const rep = JSON.parse(fs.readFileSync(path.join(FIX, 'reports', 'codex-cloud-unknown.json'), 'utf8'));
  assert.deepEqual(validateReport(rep), []);
});

test('gemini-cli reporter normalizes tokens', () => {
  const r = runReporter(['--agent', 'gemini-cli', '--chat', path.join(FIX, 'gemini', 'session-2026-11-10-gem12345.json'), '--repo', 'a/b', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(validateReport(r.json), []);
  assert.equal(r.json.accuracy, 'exact');
  const base = rowOf(r.json, 'gemini-2.5-pro', 'base');
  assert.equal(base.calls, 1); // duplicate message id ignored
  assert.equal(base.input_tokens, 620);
  assert.equal(base.cache_read_tokens, 400);
  assert.equal(base.output_tokens, 150);
  assert.equal(base.reasoning_tokens, 50);
  assert.equal(base.cache_write_tokens, 0);
  assert.equal(rowOf(r.json, 'gemini-2.5-pro', 'long').input_tokens, 300000);
});

test('writing: opaque random filename, idempotent snapshot, no sensitive fields', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-git-'));
  // No git mapping in this fixture: a report generated in one invocation must still be privacy safe.
  const a = ['--agent', 'codex-cloud', '--unknown', '--session', 'task_secret_9', '--repo', 'a/b', '--out', out];
  assert.equal(runReporter(a).status, 0);
  const files = fs.readdirSync(out);
  assert.equal(files.length, 1);
  assert.match(files[0], /^usage-[0-9a-f-]{36}\.json$/);
  const raw = fs.readFileSync(path.join(out, files[0]),'utf8');
  assert.ok(!raw.includes('task_secret_9'));
  assert.ok(!raw.includes('session_id'));
  assert.ok(!raw.includes('started_at'));
  assert.deepEqual(validateReport(JSON.parse(raw)), []);
});
