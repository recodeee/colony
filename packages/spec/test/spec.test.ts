import { describe, expect, it } from 'vitest';
import { parseSpec, serializeSpec } from '../src/grammar.js';
import { resolveTaskContext } from '../src/context.js';
import { SyncEngine } from '../src/sync.js';
import type { Change } from '../src/change.js';

const SAMPLE_SPEC = `# SPEC

## §G  goal
One spec file at root. One lifecycle for changes.

## §C  constraints
- markdown + pipe tables only.
- single-thread exec.

## §I  interfaces
- cmds: /co:spec, /co:change, /co:build
- config: openspec/config.yaml

## §V  invariants
id|rule|cites
-|-|-
V1|SPEC.md is sole source of truth|-
V2|spec is only writer of root|V1
V8.always|slash commands emit ≤ 1 status line per phase|-
V9.always|/co:check is read-only|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|x|scaffold repo root|V1
T5|.|rewrite spec skill|V1,V2
T8|.|port check skill|V9.always

## §B  bugs
id|date|cause|fix
-|-|-|-
`;

describe('grammar', () => {
  it('round-trips a sample SPEC.md', () => {
    const spec = parseSpec(SAMPLE_SPEC);
    const out = serializeSpec(spec);
    const reparsed = parseSpec(out);
    expect(reparsed.sections.V.rows?.length).toBe(4);
    expect(reparsed.sections.T.rows?.length).toBe(3);
  });

  it('identifies always-on invariants by id suffix', () => {
    const spec = parseSpec(SAMPLE_SPEC);
    expect(spec.alwaysInvariants.sort()).toEqual(['V8.always', 'V9.always']);
  });

  it('computes a stable rootHash for identical content', () => {
    expect(parseSpec(SAMPLE_SPEC).rootHash).toBe(parseSpec(SAMPLE_SPEC).rootHash);
  });
});

describe('cite-scoped context loading', () => {
  it('returns only the cited subset plus always-on invariants', () => {
    const spec = parseSpec(SAMPLE_SPEC);
    const ctx = resolveTaskContext(spec, 'T5');
    expect(ctx).not.toBeNull();
    expect(ctx!.cited_ids.sort()).toEqual(['V1', 'V2']);
    expect(ctx!.always_invariants.sort()).toEqual(['V8.always', 'V9.always']);
    // The rendered string must NOT contain invariants that weren't cited.
    // In our sample that's the "bugs" section — V has no uncited rows,
    // but T has T1 and T8 which should not appear in T5's context.
    expect(ctx!.rendered).not.toContain('T1|');
    expect(ctx!.rendered).not.toContain('T8|');
  });

  it('follows cites transitively up to depth 2', () => {
    const spec = parseSpec(SAMPLE_SPEC);
    // V2 cites V1; asking for T5 (cites V1, V2) should still show both.
    // More importantly, asking for a task that cites only V2 should
    // pull in V1 via transitive closure.
    const specWithChain = parseSpec(
      SAMPLE_SPEC.replace('T5|.|rewrite spec skill|V1,V2', 'T5|.|rewrite spec skill|V2'),
    );
    const ctx = resolveTaskContext(specWithChain, 'T5');
    expect(ctx!.cited_ids.sort()).toEqual(['V1', 'V2']);
  });

  it('returns null for unknown task ids', () => {
    const spec = parseSpec(SAMPLE_SPEC);
    expect(resolveTaskContext(spec, 'T999')).toBeNull();
  });
});

describe('sync engine conflict detection', () => {
  it('applies a clean modify when root unchanged since base', () => {
    const base = parseSpec(SAMPLE_SPEC);
    const current = parseSpec(SAMPLE_SPEC); // identical to base
    const change: Change = {
      slug: 'test',
      baseRootHash: base.rootHash,
      proposal: '',
      deltaRows: [
        {
          op: 'modify',
          target: 'V2',
          row: { id: 'V2', cells: ['V2', 'spec is only writer (revised)', 'V1'] },
        },
      ],
      tasks: [],
      bugs: [],
    };
    const engine = new SyncEngine('three_way');
    const result = engine.merge(current, base, change);
    expect(result.clean).toBe(true);
    expect(result.applied).toBe(1);
  });

  it('flags root_modified_since_base when current row != base row', () => {
    const base = parseSpec(SAMPLE_SPEC);
    const currentText = SAMPLE_SPEC.replace(
      'V2|spec is only writer of root|V1',
      'V2|spec is only writer of root AND sync|V1',
    );
    const current = parseSpec(currentText);
    const change: Change = {
      slug: 'test',
      baseRootHash: base.rootHash,
      proposal: '',
      deltaRows: [
        {
          op: 'modify',
          target: 'V2',
          row: { id: 'V2', cells: ['V2', 'a different edit', 'V1'] },
        },
      ],
      tasks: [],
      bugs: [],
    };
    const engine = new SyncEngine('three_way');
    const result = engine.merge(current, base, change);
    expect(result.clean).toBe(false);
    expect(result.conflicts[0]?.reason).toBe('root_modified_since_base');
    // three_way does NOT auto-merge; nothing applied.
    expect(result.applied).toBe(0);
  });

  it('last_writer_wins overwrites despite the conflict', () => {
    const base = parseSpec(SAMPLE_SPEC);
    const currentText = SAMPLE_SPEC.replace(
      'V2|spec is only writer of root|V1',
      'V2|spec is only writer of root AND sync|V1',
    );
    const current = parseSpec(currentText);
    const change: Change = {
      slug: 'test',
      baseRootHash: base.rootHash,
      proposal: '',
      deltaRows: [
        {
          op: 'modify',
          target: 'V2',
          row: { id: 'V2', cells: ['V2', 'forced edit', 'V1'] },
        },
      ],
      tasks: [],
      bugs: [],
    };
    const engine = new SyncEngine('last_writer_wins');
    const result = engine.merge(current, base, change);
    expect(result.conflicts.length).toBe(1);
    expect(result.applied).toBe(1);
  });

  it('flags delta_removes_cited_row when §V is removed but §T still cites it', () => {
    const base = parseSpec(SAMPLE_SPEC);
    const current = parseSpec(SAMPLE_SPEC);
    const change: Change = {
      slug: 'test',
      baseRootHash: base.rootHash,
      proposal: '',
      deltaRows: [{ op: 'remove', target: 'V1' }],
      tasks: [],
      bugs: [],
    };
    const engine = new SyncEngine('three_way');
    const result = engine.merge(current, base, change);
    expect(result.conflicts.some((c) => c.reason === 'delta_removes_cited_row')).toBe(true);
  });
});
