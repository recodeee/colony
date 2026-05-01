export interface WorkingHandoffNoteInput {
  branch?: string | undefined;
  task?: string | undefined;
  blocker?: string | undefined;
  next?: string | undefined;
  evidence?: string | undefined;
}

export interface WorkingHandoffNoteFields {
  branch: string;
  task: string;
  blocker: string;
  next: string;
  evidence: string;
}

export interface WorkingHandoffNoteResult {
  ok: boolean;
  note_text: string;
  fields: Partial<WorkingHandoffNoteFields>;
  errors: string[];
  warnings: string[];
  next_recommended_action: string;
}

export interface WorkingHandoffMetadata {
  kind?: string;
  working_note?: boolean;
  auto_handoff_note?: boolean;
  live?: boolean;
  superseded_by_observation_id?: number;
  superseded_at?: number;
  [key: string]: unknown;
}

const FIELD_LIMIT = 180;
const EVIDENCE_LIMIT = 180;
const REQUIRED_FIELDS: Array<keyof WorkingHandoffNoteFields> = [
  'branch',
  'task',
  'next',
  'evidence',
];

export function buildWorkingHandoffNote(input: WorkingHandoffNoteInput): WorkingHandoffNoteResult {
  const warnings: string[] = [];
  const fields: Partial<WorkingHandoffNoteFields> = {
    branch: compactField(input.branch, FIELD_LIMIT),
    task: compactField(input.task, FIELD_LIMIT),
    blocker: compactField(input.blocker, FIELD_LIMIT) || 'none',
    next: compactField(input.next, FIELD_LIMIT),
    evidence: compactEvidence(input.evidence, warnings),
  };
  const errors = REQUIRED_FIELDS.flatMap((field) =>
    fields[field] ? [] : [`missing required field: ${field}`],
  );

  if (errors.length > 0) {
    return {
      ok: false,
      note_text: '',
      fields,
      errors,
      warnings,
      next_recommended_action: 'provide branch, task, next, and evidence before posting',
    };
  }

  const complete = fields as WorkingHandoffNoteFields;
  return {
    ok: true,
    note_text: formatWorkingHandoffNote(complete),
    fields: complete,
    errors: [],
    warnings,
    next_recommended_action: recommendedAction(complete.blocker),
  };
}

export function formatWorkingHandoffNote(fields: WorkingHandoffNoteFields): string {
  return [
    ['branch', fields.branch],
    ['task', fields.task],
    ['blocker', fields.blocker],
    ['next', fields.next],
    ['evidence', fields.evidence],
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');
}

export function isLiveWorkingHandoffMetadata(metadata: string | null | undefined): boolean {
  const parsed = parseWorkingHandoffMetadata(metadata);
  return (
    parsed.working_note === true &&
    parsed.auto_handoff_note === true &&
    parsed.live !== false &&
    typeof parsed.superseded_by_observation_id !== 'number'
  );
}

export function supersedeWorkingHandoffMetadata(
  metadata: string | null | undefined,
  supersededByObservationId: number,
  supersededAt = Date.now(),
): WorkingHandoffMetadata {
  return {
    ...parseWorkingHandoffMetadata(metadata),
    live: false,
    superseded_by_observation_id: supersededByObservationId,
    superseded_at: supersededAt,
  };
}

export function parseWorkingHandoffMetadata(
  metadata: string | null | undefined,
): WorkingHandoffMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactEvidence(value: string | undefined, warnings: string[]): string {
  const raw = value?.trim() ?? '';
  if (!raw) return '';
  if (looksLikeProofDump(raw)) {
    warnings.push('evidence looks like a long proof/log dump; stored compact pointer only');
  }
  return compactField(raw, EVIDENCE_LIMIT);
}

function compactField(value: string | undefined, limit: number): string {
  const compact = (value ?? '')
    .replace(/[\r\n|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 3).trimEnd()}...`;
}

function looksLikeProofDump(value: string): boolean {
  if (value.length > EVIDENCE_LIMIT) return true;
  if (/[\r\n]/.test(value)) return true;
  if (/```|Traceback|stack trace|BEGIN [A-Z ]+|={4,}/i.test(value)) return true;
  return false;
}

function recommendedAction(blocker: string): string {
  if (/^(none|no|n\/a)$/i.test(blocker.trim())) {
    return 'continue work and update the working note after meaningful progress';
  }
  return 'resolve blocker or hand off before stopping';
}

function isRecord(value: unknown): value is WorkingHandoffMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
