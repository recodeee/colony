#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildReceiptBenchmark(input) {
  const rows = input.scenarios.map((scenario) => {
    const savedTokens = scenario.standard_tokens - scenario.colony_tokens;
    return {
      ...scenario,
      saved_tokens: savedTokens,
      savings_pct:
        scenario.standard_tokens <= 0
          ? 0
          : Math.round((savedTokens / scenario.standard_tokens) * 1000) / 10,
    };
  });
  const totals = rows.reduce(
    (acc, row) => ({
      standard_tokens: acc.standard_tokens + row.standard_tokens,
      colony_tokens: acc.colony_tokens + row.colony_tokens,
      saved_tokens: acc.saved_tokens + row.saved_tokens,
    }),
    { standard_tokens: 0, colony_tokens: 0, saved_tokens: 0 },
  );
  return {
    schema_version: input.schema_version,
    name: input.name,
    scenarios: rows,
    totals: {
      ...totals,
      savings_pct:
        totals.standard_tokens <= 0
          ? 0
          : Math.round((totals.saved_tokens / totals.standard_tokens) * 1000) / 10,
    },
  };
}

export function formatReceiptBenchmarkMarkdown(output) {
  let markdown = `${output.name}\n\n`;
  markdown +=
    '| Scenario | Standard tokens | Colony tokens | Saved tokens | Saved | Receipt surface |\n';
  markdown += '| --- | ---: | ---: | ---: | ---: | --- |\n';
  for (const row of output.scenarios) {
    markdown += `| ${row.title} | ${formatTokens(row.standard_tokens)} | ${formatTokens(
      row.colony_tokens,
    )} | ${formatTokens(row.saved_tokens)} | ${row.savings_pct}% | ${row.receipt_surface} |\n`;
  }
  markdown += `| Total | ${formatTokens(output.totals.standard_tokens)} | ${formatTokens(
    output.totals.colony_tokens,
  )} | ${formatTokens(output.totals.saved_tokens)} | ${output.totals.savings_pct}% | all scenarios |\n`;
  return markdown;
}

if (isMainEntry()) {
  const scenarioPath = resolve(root, 'benchmarks/receipts-scenarios.json');
  const input = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const output = buildReceiptBenchmark(input);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(formatReceiptBenchmarkMarkdown(output));
  }
}

function isMainEntry() {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

function formatTokens(value) {
  return new Intl.NumberFormat('en-US').format(value);
}
