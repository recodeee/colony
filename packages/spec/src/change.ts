import type { SpecRow } from './grammar.js';

// A DeltaRow is the unit of change in §S. Exactly one of add/modify/remove
// is populated. The `target` string is the root spec id being touched,
// e.g. 'V.3' or 'T.12' or 'I.config'.
export interface DeltaRow {
  op: 'add' | 'modify' | 'remove';
  target: string;
  row?: SpecRow;
}

export interface Change {
  slug: string;
  // Hash of the root SPEC.md captured at /co:change time. Used as the
  // common ancestor in the three-way merge at archive time.
  baseRootHash: string;
  proposal: string;
  deltaRows: DeltaRow[];
  tasks: SpecRow[];
  bugs: SpecRow[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export function parseChange(text: string, slug: string): Change {
  const fm = FRONTMATTER_RE.exec(text);
  const frontmatter: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
      if (m) frontmatter[m[1]] = m[2];
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;

  return {
    slug,
    baseRootHash: frontmatter['base_root_hash'] ?? '',
    proposal: extractSection(body, 'P'),
    deltaRows: parseDeltaRows(extractSection(body, 'S')),
    tasks: parseTableRows(extractSection(body, 'T')),
    bugs: parseTableRows(extractSection(body, 'B')),
  };
}

export function serializeChange(change: Change): string {
  const parts: string[] = [];
  parts.push('---');
  parts.push(`base_root_hash: ${change.baseRootHash}`);
  parts.push(`slug: ${change.slug}`);
  parts.push('---');
  parts.push('');
  parts.push(`# CHANGE · ${change.slug}`);
  parts.push('');
  parts.push('## §P  proposal');
  parts.push(change.proposal || '-');
  parts.push('');
  parts.push('## §S  delta');
  parts.push('op|target|row');
  parts.push('-|-|-');
  for (const d of change.deltaRows) {
    parts.push(`${d.op}|${d.target}|${d.row ? d.row.cells.join(' ') : '-'}`);
  }
  parts.push('');
  parts.push('## §T  tasks');
  parts.push(renderTable(change.tasks));
  parts.push('');
  parts.push('## §B  bugs');
  parts.push(renderTable(change.bugs));
  parts.push('');
  return parts.join('\n');
}

function extractSection(text: string, name: string): string {
  const re = new RegExp(`^##\\s+§${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+§|\\z)`, 'm');
  const match = re.exec(text);
  return match ? match[1].trim() : '';
}

function parseDeltaRows(body: string): DeltaRow[] {
  const rows = parseTableRows(body);
  const deltas: DeltaRow[] = [];
  for (const row of rows) {
    const op = row.cells[0] as DeltaRow['op'];
    const target = row.cells[1] ?? '';
    if (!op || !target) continue;
    if (op !== 'add' && op !== 'modify' && op !== 'remove') continue;
    deltas.push({ op, target, row });
  }
  return deltas;
}

function parseTableRows(body: string): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const raw of body.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^id\s*\|/.test(t) || /^op\s*\|/.test(t) || /^-+\s*\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim());
    const id = cells[0];
    if (!id || id === '-') continue;
    rows.push({ id, cells });
  }
  return rows;
}

function renderTable(rows: SpecRow[]): string {
  if (rows.length === 0) return 'id|status|task|cites\n-|-|-|-';
  const lines = ['id|status|task|cites', '-|-|-|-'];
  for (const r of rows) lines.push(r.cells.join('|'));
  return lines.join('\n');
}
