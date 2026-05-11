import type { MemoryStore } from './memory-store.js';

export const REFLEXION_OBSERVATION_KIND = 'reflexion' as const;

export type ReflexionKind = 'failure' | 'expiry' | 'rollback' | 'success';

export const REFLEXION_REWARD_BY_KIND = {
  failure: -1,
  expiry: -0.5,
  rollback: -0.25,
  success: 1,
} as const satisfies Record<ReflexionKind, number>;

interface ReflexionMetadataBase {
  task_id: number;
  attempt: number;
  /** Short caveman-friendly summary, max 120 chars. */
  action: string;
  /** What happened, max 240 chars. Stored as compressed observation content too. */
  observation_summary: string;
  /** One-line lesson, max 240 chars. Stored as compressed observation content too. */
  reflection: string;
  success: boolean;
  tags: string[];
  source_kind: string;
  source_observation_id: number | null;
  idempotency_key: string;
  observed_at: number;
}

export type ReflexionMetadata = {
  [K in ReflexionKind]: ReflexionMetadataBase & {
    kind: K;
    /** Deterministic from kind via REFLEXION_REWARD_BY_KIND, range -1..1. */
    reward: (typeof REFLEXION_REWARD_BY_KIND)[K];
  };
}[ReflexionKind] &
  Record<string, unknown>;

export interface RecordReflexionArgs {
  session_id: string;
  task_id: number;
  kind: ReflexionKind;
  action: string;
  observation_summary: string;
  reflection: string;
  source_kind: string;
  idempotency_key: string;
  source_observation_id?: number | null;
  tags?: string[];
  attempt?: number;
  reply_to?: number | null;
  now?: number;
  window_ms?: number;
}

const DEFAULT_REFLEXION_WINDOW_MS = 30 * 24 * 60 * 60_000;

export function recordReflexion(store: MemoryStore, args: RecordReflexionArgs): number {
  const now = args.now ?? Date.now();
  const metadata = buildReflexionMetadata(args, now);
  if (
    hasRecentReflexion(store, {
      task_id: args.task_id,
      idempotency_key: args.idempotency_key,
      since: now - (args.window_ms ?? DEFAULT_REFLEXION_WINDOW_MS),
    })
  ) {
    return -1;
  }

  return store.addObservation({
    session_id: args.session_id,
    kind: REFLEXION_OBSERVATION_KIND,
    content: `${metadata.observation_summary}\nReflection: ${metadata.reflection}`,
    metadata,
    task_id: args.task_id,
    ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
  });
}

function buildReflexionMetadata(args: RecordReflexionArgs, observed_at: number): ReflexionMetadata {
  if (!args.session_id.trim()) throw new Error('reflexion session_id is required');
  if (!Number.isInteger(args.task_id)) throw new Error('reflexion task_id must be an integer');
  if (!args.source_kind.trim()) throw new Error('reflexion source_kind is required');
  if (!args.idempotency_key.trim()) throw new Error('reflexion idempotency_key is required');
  const action = validateShortText(args.action, 'action', 120);
  const observation_summary = validateShortText(
    args.observation_summary,
    'observation_summary',
    240,
  );
  const reflection = validateShortText(args.reflection, 'reflection', 240);
  if (
    args.source_observation_id !== undefined &&
    args.source_observation_id !== null &&
    !Number.isInteger(args.source_observation_id)
  ) {
    throw new Error('reflexion source_observation_id must be an integer');
  }

  return {
    task_id: args.task_id,
    attempt: args.attempt ?? 1,
    action,
    observation_summary,
    reflection,
    success: args.kind === 'success',
    tags: args.tags ?? [],
    source_kind: args.source_kind,
    source_observation_id: args.source_observation_id ?? null,
    idempotency_key: args.idempotency_key,
    observed_at,
    kind: args.kind,
    reward: REFLEXION_REWARD_BY_KIND[args.kind],
  } as ReflexionMetadata;
}

function validateShortText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`reflexion ${field} is required`);
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function hasRecentReflexion(
  store: MemoryStore,
  args: { task_id: number; idempotency_key: string; since: number },
): boolean {
  return store.storage
    .taskObservationsByKind(args.task_id, REFLEXION_OBSERVATION_KIND, 200)
    .some((row) => {
      if (row.ts < args.since) return false;
      const metadata = parseMetadata(row.metadata);
      return metadata.idempotency_key === args.idempotency_key;
    });
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
