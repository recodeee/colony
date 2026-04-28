import type { Change, DeltaRow } from './change.js';
import { type Spec, type SpecSection, parseSpec, serializeSpec } from './grammar.js';

export type SyncStrategy = 'three_way' | 'refuse_on_conflict' | 'last_writer_wins';

export interface MergeConflict {
  target: string;
  reason: 'root_modified_since_base' | 'delta_removes_cited_row' | 'unknown_target';
  delta: DeltaRow;
}

export interface MergeResult {
  spec: Spec;
  conflicts: MergeConflict[];
  // True only when zero conflicts and every delta row applied cleanly.
  clean: boolean;
  applied: number;
}

// SyncEngine is pure: no IO, no task-thread writes. Callers (the sync
// skill, or SpecRepository) decide whether to persist the result and
// which strategy to honor.
//
// This is deliberately separate from repository.ts — sync is the most
// subtle correctness surface in colonykit, and testing it should not
// require the MemoryStore or the filesystem.
export class SyncEngine {
  constructor(private readonly strategy: SyncStrategy = 'three_way') {}

  // Merge a change's delta rows into the current root spec, with
  // `baseRoot` as the three-way-merge ancestor.
  merge(currentRoot: Spec, baseRoot: Spec, change: Change): MergeResult {
    const conflicts: MergeConflict[] = [];
    const next: Spec = cloneSpec(currentRoot);
    let applied = 0;

    for (const delta of change.deltaRows) {
      const conflict = this.detectConflict(currentRoot, baseRoot, delta);
      if (conflict) {
        conflicts.push(conflict);
        if (this.strategy === 'refuse_on_conflict') continue;
        if (this.strategy === 'three_way' && !isAutoMergeable(conflict)) continue;
        // last_writer_wins falls through to apply.
      }
      if (this.applyDelta(next, delta)) applied++;
    }

    return {
      spec: next,
      conflicts,
      clean: conflicts.length === 0,
      applied,
    };
  }

  // Renders a conflict report that can be embedded into SPEC.md as a
  // comment block. Useful when strategy = 'refuse_on_conflict' and the
  // human needs to resolve manually.
  static renderConflictMarkers(conflicts: MergeConflict[]): string {
    if (conflicts.length === 0) return '';
    const lines = ['<!-- COLONYKIT MERGE CONFLICTS'];
    for (const c of conflicts) {
      lines.push(`  ${c.target}: ${c.reason} (${c.delta.op})`);
    }
    lines.push('-->');
    return lines.join('\n');
  }

  private detectConflict(currentRoot: Spec, baseRoot: Spec, delta: DeltaRow): MergeConflict | null {
    const sectionLetter = sectionOf(delta.target);
    if (!sectionLetter || !['V', 'I', 'T', 'B'].includes(sectionLetter)) {
      // G/C sections are prose-only; delta rows against them are nonsensical.
      return { target: delta.target, reason: 'unknown_target', delta };
    }

    const current = findRow(currentRoot, delta.target);
    const base = findRow(baseRoot, delta.target);

    // Row drifted since the change was opened.
    if (current && base && serializeRow(current) !== serializeRow(base)) {
      return { target: delta.target, reason: 'root_modified_since_base', delta };
    }

    // Remove that targets a row something else now cites. We only flag
    // citation conflicts for §V removes because those are load-bearing;
    // removing a §T row that something cites is usually fine (task just
    // gets reassigned).
    if (delta.op === 'remove' && sectionLetter === 'V') {
      const cited = citesReferencing(currentRoot, delta.target);
      if (cited.length > 0) {
        return { target: delta.target, reason: 'delta_removes_cited_row', delta };
      }
    }

    return null;
  }

  private applyDelta(spec: Spec, delta: DeltaRow): boolean {
    const sectionLetter = sectionOf(delta.target);
    if (!sectionLetter || !['V', 'I', 'T', 'B'].includes(sectionLetter)) return false;
    const section = spec.sections[sectionLetter as 'V' | 'I' | 'T' | 'B'];
    if (!section.rows) return false;

    if (delta.op === 'remove') {
      const before = section.rows.length;
      section.rows = section.rows.filter((r) => r.id !== delta.target);
      return section.rows.length < before;
    }

    if (!delta.row) return false;
    if (delta.op === 'add') {
      section.rows.push(delta.row);
      return true;
    }
    if (delta.op === 'modify') {
      const idx = section.rows.findIndex((r) => r.id === delta.target);
      if (idx < 0) {
        section.rows.push(delta.row);
        return true;
      }
      section.rows[idx] = delta.row;
      return true;
    }
    return false;
  }
}

function isAutoMergeable(conflict: MergeConflict): boolean {
  // The only conflict shape we can auto-merge is: root unchanged, delta
  // removes cited row, and the citations are also being removed in the
  // same change. We don't handle that case here yet — conservative default
  // is to NOT auto-merge any conflict under three_way; caller must rerun
  // with last_writer_wins or resolve manually. This keeps the default
  // path safe.
  void conflict;
  return false;
}

function findRow(spec: Spec, target: string) {
  const sectionLetter = sectionOf(target);
  if (!sectionLetter) return undefined;
  const section = spec.sections[sectionLetter as 'V' | 'I' | 'T' | 'B' | 'G' | 'C'];
  if (!section?.rows) return undefined;
  return section.rows.find((r) => r.id === target);
}

// Extract the section letter from an id. Supports both styles:
//   'V1', 'T5', 'B2'        → first character is the letter
//   'V8.always', 'I.config'  → split on '.', first part
// If the id starts with a known section letter followed by anything,
// that letter wins.
function sectionOf(id: string): string | undefined {
  const first = id[0];
  if (first && ['G', 'C', 'I', 'V', 'T', 'B'].includes(first)) return first;
  return undefined;
}

function serializeRow(row: { cells: string[] }): string {
  return row.cells.join('|');
}

// Scan §T for rows that cite the given §V id. Used to detect the
// "delta removes cited row" conflict.
function citesReferencing(spec: Spec, target: string): string[] {
  const tasks = spec.sections.T?.rows ?? [];
  const result: string[] = [];
  for (const row of tasks) {
    // Conventionally, the cites column is the last one. It's comma-
    // separated ids like "V1,V3,§sync". Match on the literal target.
    const last = row.cells[row.cells.length - 1] ?? '';
    if (last.split(/[,\s]+/).some((c) => c === target)) {
      result.push(row.id);
    }
  }
  return result;
}

function cloneSpec(spec: Spec): Spec {
  const sections = {} as Spec['sections'];
  for (const [k, v] of Object.entries(spec.sections)) {
    const section: SpecSection = { name: v.name, body: v.body };
    if (v.rows) section.rows = v.rows.map((r) => ({ ...r, cells: [...r.cells] }));
    (sections as Record<string, SpecSection>)[k] = section;
  }
  return { ...spec, sections, alwaysInvariants: [...spec.alwaysInvariants] };
}
