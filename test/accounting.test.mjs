import test from 'node:test';
import assert from 'node:assert/strict';
import { processedTokens, nonCachedPlusOutput, strictSum, rowCost, validateReport, canonicalModelId } from '../site/lib/accounting.js';
import { pricing } from './helpers.mjs';

const opus = { model: 'claude-opus-5-5', price_tier: null, input_tokens: 422, output_tokens: 210947, cache_read_tokens: 62499804, cache_write_tokens: 438809, cache_write_5m_tokens: 0, cache_write_1h_tokens: 438809 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('processed and non-cached sums', () => {
  assert.equal(processedTokens(opus), 63149982);
  assert.equal(nonCachedPlusOutput(opus), 211369);
  assert.equal(strictSum(1, 2, 3), 6);
});

test('null propagates, never treated as zero', () => {
  assert.equal(processedTokens({ ...opus, cache_write_tokens: null }), null);
  assert.equal(nonCachedPlusOutput({ ...opus, input_tokens: null }), null);
  assert.equal(nonCachedPlusOutput({ ...opus, cache_read_tokens: null }), 211369);
  assert.equal(strictSum(1, undefined), null);
});

test('exact cost for claude-opus-5-5 with 5m/1h split', () => {
  // 422*4 + 210947*20 + 62499804*0.2 + 438809*8 (1h) = 20_231_060.8 / 1e6
  close(rowCost(opus, pricing, '2026-11-09').cost, 20.2310608);
  const mixed = { ...opus, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 3000000, cache_write_5m_tokens: 1000000, cache_write_1h_tokens: 2000000 };
  close(rowCost(mixed, pricing, '2026-11-09').cost, 5 + 16);
});

test('unknown model gets no price and never another model\'s price', () => {
  const r = rowCost({ ...opus, model: 'claude-opus-9' }, pricing, '2026-11-09');
  assert.equal(r.cost, null);
  assert.equal(r.reason, 'no verified price');
  assert.equal(rowCost({ ...opus, model: null }, pricing, '2026-11-09').cost, null);
});

test('unknown cache-write split gives null cost', () => {
  const r = rowCost({ ...opus, cache_write_5m_tokens: null, cache_write_1h_tokens: null }, pricing, '2026-11-09');
  assert.equal(r.cost, null);
  assert.match(r.reason, /split unknown/);
  // no cache writes -> split is irrelevant
  assert.notEqual(rowCost({ ...opus, cache_write_tokens: 0, cache_write_5m_tokens: null, cache_write_1h_tokens: null }, pricing, '2026-11-09').cost, null);
});

test('tiered model requires price_tier', () => {
  const haiku = { model: 'claude-haiku-5-5', price_tier: null, input_tokens: 1000000, output_tokens: 1000000, cache_read_tokens: 0, cache_write_tokens: 0 };
  const r = rowCost(haiku, pricing, '2026-11-09');
  assert.equal(r.cost, null);
  assert.match(r.reason, /tiered/);
  close(rowCost({ ...haiku, price_tier: 'base' }, pricing, '2026-11-09').cost, 0.1 + 0.5);
  close(rowCost({ ...haiku, price_tier: 'long' }, pricing, '2026-11-09').cost, 0.5 + 2.5);
});

test('dated price periods (gemini-4-carbon)', () => {
  const g = { model: 'gemini-4-carbon', price_tier: null, input_tokens: 1000000, output_tokens: 1000000, cache_read_tokens: 0, cache_write_tokens: 0 };
  close(rowCost(g, pricing, '2026-11-30').cost, 12);
  close(rowCost(g, pricing, '2026-12-01').cost, 24);
  assert.equal(rowCost(g, pricing, null).cost, null);
});

test('openai cache writes stay unpriced', () => {
  const r = rowCost({ model: 'gpt-6-astra', price_tier: 'base', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 5 }, pricing, '2026-11-09');
  assert.equal(r.cost, null);
});

test('date-suffixed snapshot id maps to the same model', () => {
  assert.equal(canonicalModelId('claude-opus-5-5-20261001'), 'claude-opus-5-5');
  close(rowCost({ ...opus, model: 'claude-opus-5-5-20261001' }, pricing, '2026-11-09').cost, 20.2310608);
});

// ── validateReport
const base = () => ({
  schema: 'game-ai-usage/report@2', report_id: '6bb92743-8a6c-4c2a-8455-9ce68ed26d52', repo: 'a/b', date: '2026-11-09',
  accuracy: 'exact',
  models: [{ provider: 'anthropic', model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 }],
});
test('validateReport: valid exact', () => assert.deepEqual(validateReport(base()), []));
test('validateReport: unknown with nulls is valid', () => {
  const r = { ...base(), accuracy: 'unknown', models: [{ provider: 'openai', model: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null }] };
  assert.deepEqual(validateReport(r), []);
});
test('validateReport: unknown with numbers is invalid', () => {
  const r = { ...base(), accuracy: 'unknown' };
  assert.ok(validateReport(r).some((e) => /unknown/.test(e)));
});
test('validateReport: exact with a null field is invalid', () => {
  const r = base(); r.models[0].cache_write_tokens = null;
  assert.ok(validateReport(r).length > 0);
});
test('validateReport: bad report_id, bad numbers, bad tier', () => {
  assert.ok(validateReport({ ...base(), report_id: 'raw-id' }).some((e) => /report_id/.test(e)));
  const r = base(); r.models[0].input_tokens = -1; r.models[0].price_tier = 'mega';
  assert.equal(validateReport(r).length, 2);
  assert.ok(validateReport(null).length);
});

test('privacy: reject legacy metadata even with a valid report id', () => {
 for (const field of ['session_id','task','started_at','ended_at','reported_at','notes','agent']) {
  assert.ok(validateReport({ ...base(), [field]: 'sensitive' }).length > 0, field);
 }
});
