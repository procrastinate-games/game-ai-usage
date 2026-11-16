// Shared token accounting + API-equivalent cost estimation.
// Used by scripts/aggregate.mjs (Node), the tests, and the browser (site/app.js).
// Zero dependencies, plain ES module.
//
// Normalized model rows (see docs/token-accounting.md) use DISJOINT fields:
//   input_tokens        non-cached input only
//   cache_read_tokens   input served from cache
//   cache_write_tokens  input written to cache (= cache_write_5m + cache_write_1h when split is known)
//   output_tokens       generated output, including reasoning/thinking
// Any field may be null = unknown. Unknown is never treated as zero.

export const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Sum of values where null means "unknown". Returns null when any part is unknown.
export function strictSum(...vals) {
  let s = 0;
  for (const v of vals) {
    if (!isNum(v)) return null;
    s += v;
  }
  return s;
}

// Total Processed Tokens: everything the model processed, each token counted once.
export function processedTokens(row) {
  return strictSum(row.input_tokens, row.cache_read_tokens, row.cache_write_tokens, row.output_tokens);
}

// Non-cached input + output (excludes cache reads and cache writes).
export function nonCachedPlusOutput(row) {
  return strictSum(row.input_tokens, row.output_tokens);
}

// Accumulator that keeps the known sum and whether every contribution was known.
export function knownSum() {
  return { value: 0, complete: true, known: 0, unknown: 0 };
}
export function addKnown(acc, v) {
  if (isNum(v)) { acc.value += v; acc.known++; }
  else { acc.complete = false; acc.unknown++; }
  return acc;
}

// Strip a trailing date snapshot suffix, e.g. claude-haiku-4-5-20251001 -> claude-haiku-4-5.
// This maps a dated snapshot to the SAME model; it never maps to a different model.
export function canonicalModelId(model) {
  if (!model) return model;
  return String(model).trim().toLowerCase().replace(/-(\d{8})$/, '').replace(/@\d{8}$/, '');
}

export function findPriceEntry(pricing, model) {
  if (!pricing || !model) return null;
  const id = canonicalModelId(model);
  const aliased = (pricing.aliases || {})[id] || id;
  const entry = pricing.models?.[aliased];
  return entry ? { id: aliased, entry } : null;
}

function inPeriod(p, date) {
  if (!date) return !p.from && !p.to; // undated usage can only use an open-ended period
  if (p.from && date < p.from) return false;
  if (p.to && date > p.to) return false;
  return true;
}

// Resolve the price table for a model on a given usage date (YYYY-MM-DD) and tier.
// Returns { prices } or { prices: null, reason }.
export function resolvePrices(entry, date, priceTier) {
  let prices = entry.prices || null;
  if (entry.periods?.length) {
    const p = entry.periods.find((x) => inPeriod(x, date));
    if (!p) return { prices: null, reason: date ? 'no price period covers this date' : 'usage date unknown for dated pricing' };
    prices = p.prices;
  }
  if (entry.tiers) {
    const tierApplies = !entry.tiers.until || (date && date <= entry.tiers.until);
    if (tierApplies) {
      if (!priceTier) return { prices: null, reason: 'tiered pricing; per-request prompt-size split not reported' };
      if (priceTier === 'long') prices = entry.tiers.long;
      else if (priceTier !== 'base') return { prices: null, reason: `unknown price tier "${priceTier}"` };
    }
  }
  if (!prices) return { prices: null, reason: 'no price table' };
  return { prices };
}

// API-equivalent cost estimate for one normalized model row.
// Returns { cost: number|null, reason?: string }. Never falls back to another model's price.
export function rowCost(row, pricing, date) {
  const found = findPriceEntry(pricing, row.model);
  if (!found) return { cost: null, reason: 'no verified price' };
  const { prices, reason } = resolvePrices(found.entry, date, row.price_tier);
  if (!prices) return { cost: null, reason };

  const { input_tokens: inp, output_tokens: out, cache_read_tokens: cr, cache_write_tokens: cw } = row;
  if (![inp, out, cr, cw].every(isNum)) return { cost: null, reason: 'incomplete token data' };

  let cost = (inp * prices.input + out * prices.output) / 1e6;

  if (cr > 0) {
    if (!isNum(prices.cache_read)) return { cost: null, reason: 'no cache-read price' };
    cost += (cr * prices.cache_read) / 1e6;
  }

  if (cw > 0) {
    if (isNum(prices.cache_write_5m) || isNum(prices.cache_write_1h)) {
      const w5 = row.cache_write_5m_tokens, w1 = row.cache_write_1h_tokens;
      if (!isNum(w5) || !isNum(w1) || w5 + w1 !== cw) {
        return { cost: null, reason: 'cache-write duration (5m/1h) split unknown' };
      }
      if ((w5 > 0 && !isNum(prices.cache_write_5m)) || (w1 > 0 && !isNum(prices.cache_write_1h))) {
        return { cost: null, reason: 'no price for this cache-write duration' };
      }
      cost += ((w5 ? w5 * prices.cache_write_5m : 0) + (w1 ? w1 * prices.cache_write_1h : 0)) / 1e6;
    } else if (isNum(prices.cache_write)) {
      cost += (cw * prices.cache_write) / 1e6;
    } else {
      return { cost: null, reason: 'cache writes reported but no verified cache-write price' };
    }
  }
  return { cost };
}

// ── Report validation (shared by aggregator and reporter tests) ────────────
export const REPORT_SCHEMA = 'game-ai-usage/report@2';
export const AGENTS = ['claude-code', 'codex', 'codex-cloud', 'gemini-cli', 'other'];
export const ACCURACY = ['exact', 'partial', 'unknown'];
export const SOURCES = ['claude-code-transcript', 'codex-rollout', 'gemini-cli-session', 'agent-self-report', 'manual', 'unavailable'];
const MODEL_NUM_FIELDS = [...TOKEN_FIELDS, 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'reasoning_tokens', 'calls'];

// Returns an array of error strings (empty = valid).
export function validateReport(r) {
  const errs = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['report is not an object'];
  if (r.schema !== 'game-ai-usage/report@2') errs.push('report schema must be @2');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.report_id || '')) errs.push('report_id must be an opaque random UUID');
  if (typeof r.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) errs.push('repo must be owner/name');
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errs.push('date must be YYYY-MM-DD');
  if (!ACCURACY.includes(r.accuracy)) errs.push('invalid accuracy');
  const allowed = new Set(['schema', 'report_id', 'repo', 'date', 'accuracy', 'models']);
  for (const key of Object.keys(r)) if (!allowed.has(key)) errs.push('forbidden metadata: ' + key);
  if (!Array.isArray(r.models)) errs.push('models must be an array');
  else {
    r.models.forEach((m, i) => {
      if (!m || typeof m !== 'object') { errs.push(`models[${i}] is not an object`); return; }
      if (m.model != null && typeof m.model !== 'string') errs.push(`models[${i}].model must be a string or null`);
      if (typeof m.provider !== 'string') errs.push(`models[${i}].provider is required`);
      for (const f of MODEL_NUM_FIELDS) {
        const v = m[f];
        if (v === undefined || v === null) continue;
        if (!isNum(v) || v < 0 || !Number.isInteger(v)) errs.push(`models[${i}].${f} must be a non-negative integer or null`);
      }
      if (m.price_tier != null && !['base', 'long'].includes(m.price_tier)) errs.push('bad price_tier');
    });
    if (r.accuracy === 'exact' && !(r.models.length > 0 && r.models.every((m) => TOKEN_FIELDS.every((f) => isNum(m[f]))))) errs.push('accuracy exact requires complete data');
    if (r.accuracy === 'unknown' && r.models.some((m) => TOKEN_FIELDS.some((f) => isNum(m[f])))) errs.push('accuracy unknown must not contain numbers');
  }
  return errs;
}

// Normalize undefined -> null for token fields so downstream math is explicit.
export function normalizeModelRow(m) {
  const out = { provider: m.provider, model: m.model ?? null, price_tier: m.price_tier ?? null };
  for (const f of MODEL_NUM_FIELDS) out[f] = isNum(m[f]) ? m[f] : null;
  return out;
}
