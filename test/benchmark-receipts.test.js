const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

test('receipt benchmark script emits reproducible totals', async () => {
  const { buildReceiptBenchmark, formatReceiptBenchmarkMarkdown } = await import(
    '../scripts/benchmark-receipts.mjs'
  );
  const input = JSON.parse(readFileSync('benchmarks/receipts-scenarios.json', 'utf8'));
  const payload = buildReceiptBenchmark(input);

  assert.equal(payload.scenarios.length, 3);
  assert.equal(payload.totals.standard_tokens, 220000);
  assert.equal(payload.totals.colony_tokens, 10500);
  assert.equal(payload.totals.saved_tokens, 209500);
  assert.equal(payload.totals.savings_pct, 95.2);
  assert.match(formatReceiptBenchmarkMarkdown(payload), /Total \| 220,000 \| 10,500/);
});
