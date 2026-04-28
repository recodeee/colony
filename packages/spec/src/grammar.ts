import { compress, expand } from '@colony/compress';

// The six fixed sections of SPEC.md, in order. Section order is part of
// the grammar — parsers rely on it when a section is empty and its
// trailing whitespace is ambiguous.
export const SPEC_SECTIONS = ['G', 'C', 'I', 'V', 'T', 'B'] as const;
export type SpecSectionName = (typeof SPEC_SECTIONS)[number];

export interface SpecSection {
  name: SpecSectionName;
  // The section body in its on-disk form (caveman-compressed).
  // Consumers call expandSection() when they need human-readable text.
  body: string;
  // Parsed rows for table-valued sections (V/T/B). Undefined for prose
  // sections (G/C/I).
  rows?: SpecRow[];
}

export interface SpecRow {
  id: string;
  // For §V: "status | invariant text"; we just store the full rendered
  // row and let callers split on '|' when they need structure. Keeping
  // the shape loose here lets new column conventions ship without a
  // grammar version bump.
  cells: string[];
}

export interface Spec {
  sections: Record<SpecSectionName, SpecSection>;
  // Front-matter hash. Recomputed on every serialize; stored here so
  // consumers can pass it to openChange() without re-hashing.
  rootHash: string;
  // Always-on invariants: §V entries whose id ends with `.always`.
  // Precomputed for the cite-scoped loader.
  alwaysInvariants: string[];
}

export function parseSpec(text: string): Spec {
  const sections: Record<string, SpecSection> = {};
  const headerMatches: Array<{ name: SpecSectionName; start: number; end: number }> = [];

  const re = /^##\s+§([GCIVTB])\b.*$/gm;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const name = match[1] as SpecSectionName;
    headerMatches.push({ name, start: match.index, end: match.index + match[0].length });
    match = re.exec(text);
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const cur = headerMatches[i];
    if (!cur) continue;
    const next = headerMatches[i + 1];
    const bodyStart = cur.end;
    const bodyEnd = next ? next.start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    sections[cur.name] = {
      name: cur.name,
      body,
      ...(isTableSection(cur.name) ? { rows: parseRows(body) } : {}),
    };
  }

  // Fill in missing sections as empty. The grammar requires all six to
  // exist; this keeps downstream consumers from null-checking.
  for (const name of SPEC_SECTIONS) {
    if (!sections[name]) {
      sections[name] = { name, body: '', ...(isTableSection(name) ? { rows: [] } : {}) };
    }
  }

  const alwaysInvariants = (sections.V.rows ?? [])
    .filter((row) => row.id.endsWith('.always'))
    .map((row) => row.id);

  return {
    sections: sections as Record<SpecSectionName, SpecSection>,
    rootHash: hashOf(text),
    alwaysInvariants,
  };
}

export function serializeSpec(spec: Spec): string {
  const parts: string[] = ['# SPEC\n'];
  const titles: Record<SpecSectionName, string> = {
    G: '## §G  goal',
    C: '## §C  constraints',
    I: '## §I  interfaces',
    V: '## §V  invariants',
    T: '## §T  tasks',
    B: '## §B  bugs',
  };
  for (const name of SPEC_SECTIONS) {
    parts.push(titles[name]);
    const section = spec.sections[name];
    if (section.body) {
      parts.push(section.body);
    } else {
      parts.push('-');
    }
    parts.push('');
  }
  return parts.join('\n');
}

// Runs the caveman compressor on prose sections; table sections are
// passed through unchanged because literal preservation is critical for
// pipe-table rows (they contain paths, commands, env names).
export function compressSpec(spec: Spec, intensity: 'lite' | 'full' | 'ultra' = 'full'): Spec {
  const next: Record<SpecSectionName, SpecSection> = { ...spec.sections };
  for (const name of SPEC_SECTIONS) {
    if (!isTableSection(name)) {
      next[name] = {
        ...spec.sections[name],
        body: compress(spec.sections[name].body, { intensity }),
      };
    }
  }
  return { ...spec, sections: next };
}

export function expandSpec(spec: Spec): Spec {
  const next: Record<SpecSectionName, SpecSection> = { ...spec.sections };
  for (const name of SPEC_SECTIONS) {
    if (!isTableSection(name)) {
      next[name] = { ...spec.sections[name], body: expand(spec.sections[name].body) };
    }
  }
  return { ...spec, sections: next };
}

function isTableSection(name: SpecSectionName): boolean {
  return name === 'V' || name === 'T' || name === 'B';
}

function parseRows(body: string): SpecRow[] {
  const lines = body.split('\n').filter((l) => l.trim().startsWith('|') || /^\S+\|/.test(l.trim()));
  const rows: SpecRow[] = [];
  for (const raw of lines) {
    // Skip header + separator rows (id|status|... and -|-|-|-).
    const trimmed = raw.trim();
    if (!trimmed || /^id\s*\|/.test(trimmed) || /^-+\s*\|/.test(trimmed)) continue;
    const cells = trimmed.split('|').map((c) => c.trim());
    const id = cells[0];
    if (!id || id === '-') continue;
    rows.push({ id, cells });
  }
  return rows;
}

// Hash is used by the sync contract as a three-way-merge ancestor
// marker. We use a simple FNV-1a because the dependency surface should
// stay zero — no crypto imports for what's effectively a change-detector.
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
