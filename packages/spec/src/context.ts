import type { Spec, SpecRow } from './grammar.js';

export interface ResolvedContext {
  // §G is always included.
  goal: string;
  // The root §T row being executed.
  task: SpecRow;
  // §V/§I/§T ids reachable from the task's cites column.
  cited_ids: string[];
  // Always-on invariants (§V entries with id ending `.always`).
  always_invariants: string[];
  // The rendered, caveman-encoded context string the agent sees.
  rendered: string;
  // Ids referenced during execution that were NOT in cited_ids + always.
  // Populated lazily at runtime by the build skill — not by this function.
  // The field lives here because the consumer (ResolvedContext -> log
  // entry) wants it in one struct.
  manifest_misses?: string[];
}

// Pure: no IO. Takes a parsed spec and a task id, returns the slice.
// Cite syntax on §T rows: comma-separated list of ids in the last cell,
// e.g. `T5|~|rewrite skills/spec|V1,V2,§sync`. Non-id tokens (prefixed
// with `§`, like `§sync`, `§migration`) are section pointers and are
// rendered as section references.
export function resolveTaskContext(spec: Spec, taskId: string): ResolvedContext | null {
  const tasks = spec.sections['T']?.rows ?? [];
  const task = tasks.find((r) => r.id === taskId);
  if (!task) return null;

  const citeCell = task.cells[task.cells.length - 1] ?? '';
  const tokens = citeCell
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && t !== '-');

  // Expand the closure: when a cite points to a §V row, follow that row's
  // cites column too, up to a small depth. Depth-2 is enough in practice
  // — deeper closures usually indicate the spec is leaking everything
  // everywhere and the author needs to tighten the cites.
  const closure = new Set<string>(tokens);
  const depth = 2;
  let frontier = [...tokens];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const row = findRow(spec, id);
      if (!row) continue;
      const childCell = row.cells[row.cells.length - 1] ?? '';
      const children = childCell
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t && t !== '-');
      for (const c of children) {
        if (!closure.has(c)) {
          closure.add(c);
          next.push(c);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const always = spec.alwaysInvariants;
  const rendered = renderContext(spec, task, [...closure], always);
  return {
    goal: spec.sections['G'].body,
    task,
    cited_ids: [...closure],
    always_invariants: always,
    rendered,
  };
}

function findRow(spec: Spec, id: string): SpecRow | undefined {
  for (const name of ['V', 'I', 'T', 'B'] as const) {
    const row = spec.sections[name].rows?.find((r) => r.id === id);
    if (row) return row;
  }
  return undefined;
}

function renderContext(
  spec: Spec,
  task: SpecRow,
  cited: string[],
  always: string[],
): string {
  const parts: string[] = [];
  parts.push(`# task · ${task.id}`);
  parts.push('');
  parts.push('## §G  goal');
  parts.push(spec.sections['G'].body.trim());
  parts.push('');
  parts.push('## this task');
  parts.push(task.cells.join(' | '));
  parts.push('');

  const citedRows = cited
    .map((id) => ({ id, row: findRow(spec, id) }))
    .filter((e): e is { id: string; row: SpecRow } => !!e.row);

  if (citedRows.length > 0) {
    parts.push('## cited');
    for (const { row } of citedRows) {
      parts.push(`- ${row.cells.join(' | ')}`);
    }
    parts.push('');
  }

  if (always.length > 0) {
    const alwaysRows = always
      .map((id) => findRow(spec, id))
      .filter((r): r is SpecRow => !!r);
    parts.push('## §V always-on');
    for (const row of alwaysRows) {
      parts.push(`- ${row.cells.join(' | ')}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
