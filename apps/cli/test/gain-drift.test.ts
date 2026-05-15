import { classifyDrift, type DriftRawRow } from '@colony/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeDriftReport } from '../src/commands/gain.js';

// kleur emits ANSI when COLORTERM is set (Anthropic harness frequently
// flips this on). Strip escapes so substring checks hold regardless of
// the local color mode.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (chunk: string | Uint8Array): string => String(chunk).replace(ANSI_RE, '');

function capture(): { read: () => string } {
  let buf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    buf += stripAnsi(chunk);
    return true;
  });
  return { read: () => buf };
}

describe('writeDriftReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders header, threshold note, and an up-drift row first', () => {
    const rows: DriftRawRow[] = [
      {
        operation: 'search',
        baseline_median: 400,
        baseline_n: 2_140,
        recent_median: 580,
        recent_n: 412,
      },
      {
        operation: 'task_post',
        baseline_median: 180,
        baseline_n: 980,
        recent_median: 182,
        recent_n: 198,
      },
    ];
    const report = classifyDrift(rows, {
      threshold: 1.25,
      down_threshold: 0.75,
      min_calls: 20,
    });
    const out = capture();
    writeDriftReport(report, { recentDays: 3, baselineDays: 14, baselineWarning: null });
    const text = out.read();

    expect(text).toContain('colony gain drift (recent 3d vs baseline 14d)');
    expect(text).toContain('Thresholds: up >= 1.25x, down <= 0.75x, min 20 calls');
    expect(text).toContain('Operation');
    expect(text).toContain('Baseline med');
    expect(text).toContain('Class');
    // up_drift row appears before stable row.
    const searchIdx = text.indexOf('search');
    const taskIdx = text.indexOf('task_post');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(searchIdx);
    expect(text).toContain('up_drift');
    expect(text).toContain('stable');
  });

  it('lists new tools, gone tools, and insufficient data under the table', () => {
    const rows: DriftRawRow[] = [
      {
        operation: 'savings_drift_report',
        baseline_median: null,
        baseline_n: 0,
        recent_median: 220,
        recent_n: 25,
      },
      {
        operation: 'legacy_search',
        baseline_median: 300,
        baseline_n: 50,
        recent_median: null,
        recent_n: 0,
      },
      {
        operation: 'suggest',
        baseline_median: 80,
        baseline_n: 3,
        recent_median: 88,
        recent_n: 18,
      },
    ];
    const report = classifyDrift(rows, {
      threshold: 1.25,
      down_threshold: 0.75,
      min_calls: 20,
    });
    const out = capture();
    writeDriftReport(report, { recentDays: 3, baselineDays: 14, baselineWarning: null });
    const text = out.read();
    expect(text).toContain('New tools (no baseline): savings_drift_report');
    expect(text).toContain('Gone tools (no recent calls): legacy_search');
    expect(text).toContain('Insufficient data (n<20): suggest');
  });

  it('emits a [warn] line when the baseline window predates the first receipt', () => {
    const report = classifyDrift([], {
      threshold: 1.25,
      down_threshold: 0.75,
      min_calls: 20,
    });
    const out = capture();
    writeDriftReport(report, {
      recentDays: 3,
      baselineDays: 14,
      baselineWarning:
        'baseline window starts before first recorded metric — drift detection needs ~5 more days of history',
    });
    const text = out.read();
    expect(text).toContain('[warn]');
    expect(text).toContain('baseline window starts before first recorded metric');
  });

  it('classifies a down-drift row separately and renders down_drift class', () => {
    const rows: DriftRawRow[] = [
      {
        operation: 'task_post',
        baseline_median: 600,
        baseline_n: 30,
        recent_median: 300,
        recent_n: 30,
      },
    ];
    const report = classifyDrift(rows, {
      threshold: 1.25,
      down_threshold: 0.75,
      min_calls: 20,
    });
    expect(report.rows[0]?.classification).toBe('down_drift');
    expect(report.rows[0]?.ratio).toBeCloseTo(0.5, 6);
    const out = capture();
    writeDriftReport(report, { recentDays: 3, baselineDays: 14, baselineWarning: null });
    expect(out.read()).toContain('down_drift');
  });

  it('classifyDrift round-trips JSON-friendly shape', () => {
    const rows: DriftRawRow[] = [
      {
        operation: 'search',
        baseline_median: 400,
        baseline_n: 100,
        recent_median: 600,
        recent_n: 100,
      },
    ];
    const report = classifyDrift(rows, {
      threshold: 1.25,
      down_threshold: 0.75,
      min_calls: 20,
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual({
      threshold: { up: 1.25, down: 0.75, min_calls: 20 },
      rows: [
        {
          operation: 'search',
          baseline_median: 400,
          baseline_n: 100,
          recent_median: 600,
          recent_n: 100,
          ratio: 1.5,
          classification: 'up_drift',
        },
      ],
      new_tools: [],
      gone_tools: [],
      insufficient_data: [],
    });
  });
});
