export type SignalKind =
  | 'claim'
  | 'handoff'
  | 'message'
  | 'proposal'
  | 'foraging'
  | 'plan-subtask'
  | 'plan-subtask-claim'
  | 'wake_request'
  | 'relay'
  | (string & {});

export interface SignalMetadata {
  signal_kind: SignalKind;
  strength: number;
  created_at: number;
  last_reinforced_at: number;
  expires_at: number | null;
  half_life_minutes: number | null;
  source_session_id: string | null;
  source_agent: string | null;
  reinforced_by_sessions: string[];
}

export interface SignalMetadataDefaults {
  signal_kind?: SignalKind;
  strength?: number;
  created_at?: number;
  last_reinforced_at?: number | null;
  expires_at?: number | null;
  half_life_minutes?: number | null;
  source_session_id?: string | null;
  source_agent?: string | null;
  reinforced_by_sessions?: string[];
}

export interface SignalObservationLike {
  kind: string;
  metadata?: string | Record<string, unknown> | null;
  ts: number;
  session_id: string;
}

export interface SignalProposalLike {
  proposed_by: string;
  proposed_at: number;
}

export interface SignalReinforcementLike {
  session_id: string;
  weight: number;
  reinforced_at: number;
}

export interface ProposalSignalOptions {
  signal_kind?: SignalKind;
  half_life_minutes?: number | null;
  source_agent?: string | null;
  reinforcements?: SignalReinforcementLike[];
  strength?: number;
}

export const DEFAULT_SIGNAL_STRENGTH = 1;
export const PROPOSAL_SIGNAL_HALF_LIFE_MINUTES = 60;

/**
 * Normalize a compact or legacy metadata blob into the full signal shape.
 * New writers may store the compact form under `metadata.signal`; older rows
 * are inferred from their existing top-level fields plus caller defaults.
 */
export function normalizeSignalMetadata(
  raw: string | Record<string, unknown> | null | undefined,
  defaults: SignalMetadataDefaults = {},
): SignalMetadata | null {
  const record = parseRecord(raw);
  const signalRecord = readRecord(record.signal) ?? record;
  const signalKind = readString(
    signalRecord.signal_kind,
    record.signal_kind,
    signalRecord.kind,
    record.kind,
    defaults.signal_kind,
  );
  if (!signalKind) return null;

  const createdAt = readNumber(
    signalRecord.created_at,
    record.created_at,
    signalRecord.proposed_at,
    record.proposed_at,
    defaults.created_at,
  );
  if (createdAt === undefined) return null;

  const sourceSessionId =
    readString(
      signalRecord.source_session_id,
      record.source_session_id,
      signalRecord.from_session_id,
      record.from_session_id,
      signalRecord.session_id,
      record.session_id,
      signalRecord.proposed_by,
      record.proposed_by,
      defaults.source_session_id,
    ) ?? null;

  const sourceAgent =
    readString(
      signalRecord.source_agent,
      record.source_agent,
      signalRecord.from_agent,
      record.from_agent,
      signalRecord.agent,
      record.agent,
      defaults.source_agent,
    ) ?? null;

  const strength =
    readNumber(signalRecord.strength, record.strength, defaults.strength) ??
    DEFAULT_SIGNAL_STRENGTH;
  const lastReinforcedAt =
    readNullableNumber(
      signalRecord.last_reinforced_at,
      record.last_reinforced_at,
      signalRecord.reinforced_at,
      record.reinforced_at,
      signalRecord.claimed_at,
      record.claimed_at,
      defaults.last_reinforced_at,
    ) ?? createdAt;
  const expiresAt =
    readNullableNumber(signalRecord.expires_at, record.expires_at, defaults.expires_at) ?? null;
  const halfLifeMinutes =
    readNullableNumber(
      signalRecord.half_life_minutes,
      record.half_life_minutes,
      defaults.half_life_minutes,
    ) ?? null;
  const reinforcedBySessions = uniqueStrings(
    readStringArray(
      signalRecord.reinforced_by_sessions,
      record.reinforced_by_sessions,
      defaults.reinforced_by_sessions,
    ) ?? (signalKind === 'proposal' && sourceSessionId ? [sourceSessionId] : []),
  );

  return {
    signal_kind: signalKind,
    strength: Math.max(0, strength),
    created_at: createdAt,
    last_reinforced_at: Math.max(createdAt, lastReinforcedAt),
    expires_at: expiresAt,
    half_life_minutes: halfLifeMinutes !== null && halfLifeMinutes > 0 ? halfLifeMinutes : null,
    source_session_id: sourceSessionId,
    source_agent: sourceAgent,
    reinforced_by_sessions: reinforcedBySessions,
  };
}

export function signalMetadataFromObservation(
  row: SignalObservationLike,
  defaults: SignalMetadataDefaults = {},
): SignalMetadata | null {
  return normalizeSignalMetadata(row.metadata ?? null, {
    signal_kind: row.kind,
    created_at: row.ts,
    source_session_id: row.session_id,
    ...defaults,
  });
}

export function signalMetadataFromProposal(
  proposal: SignalProposalLike,
  options: ProposalSignalOptions = {},
): SignalMetadata {
  const halfLifeMinutes =
    options.half_life_minutes === undefined
      ? PROPOSAL_SIGNAL_HALF_LIFE_MINUTES
      : options.half_life_minutes;
  const reinforcements = options.reinforcements ?? [];
  const lastReinforcedAt =
    reinforcements.reduce(
      (latest, row) => Math.max(latest, row.reinforced_at),
      proposal.proposed_at,
    ) || proposal.proposed_at;
  const strength =
    options.strength ??
    strengthAt(reinforcements, lastReinforcedAt, halfLifeMinutes) ??
    DEFAULT_SIGNAL_STRENGTH;

  return {
    signal_kind: options.signal_kind ?? 'proposal',
    strength: Math.max(0, strength),
    created_at: proposal.proposed_at,
    last_reinforced_at: Math.max(proposal.proposed_at, lastReinforcedAt),
    expires_at: null,
    half_life_minutes: halfLifeMinutes !== null && halfLifeMinutes > 0 ? halfLifeMinutes : null,
    source_session_id: proposal.proposed_by,
    source_agent: options.source_agent ?? null,
    reinforced_by_sessions: uniqueStrings([
      proposal.proposed_by,
      ...reinforcements.map((row) => row.session_id),
    ]),
  };
}

export function compactSignalMetadata(signal: SignalMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {
    signal_kind: signal.signal_kind,
    strength: signal.strength,
    created_at: signal.created_at,
  };
  if (signal.last_reinforced_at !== signal.created_at) {
    out.last_reinforced_at = signal.last_reinforced_at;
  }
  if (signal.expires_at !== null) out.expires_at = signal.expires_at;
  if (signal.half_life_minutes !== null) out.half_life_minutes = signal.half_life_minutes;
  if (signal.source_session_id !== null) out.source_session_id = signal.source_session_id;
  if (signal.source_agent !== null) out.source_agent = signal.source_agent;
  if (signal.reinforced_by_sessions.length > 0) {
    out.reinforced_by_sessions = signal.reinforced_by_sessions;
  }
  return out;
}

export function withSignalMetadata(
  metadata: Record<string, unknown>,
  signal: SignalMetadata,
): Record<string, unknown> {
  return { ...metadata, signal: compactSignalMetadata(signal) };
}

export function isSignalExpired(signal: SignalMetadata, at = Date.now()): boolean {
  return signal.expires_at !== null && at >= signal.expires_at;
}

export function currentSignalStrength(signal: SignalMetadata, at = Date.now()): number {
  if (isSignalExpired(signal, at)) return 0;
  if (signal.half_life_minutes === null) return signal.strength;
  const elapsed = Math.max(0, at - signal.last_reinforced_at);
  const halfLifeMs = signal.half_life_minutes * 60_000;
  return signal.strength * Math.exp((-Math.LN2 * elapsed) / halfLifeMs);
}

function parseRecord(
  raw: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return readRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return raw;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function readStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.length > 0) return strings;
  }
  return undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readNullableNumber(...values: unknown[]): number | null | undefined {
  for (const value of values) {
    if (value === null) return null;
    const n = readNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function strengthAt(
  reinforcements: SignalReinforcementLike[],
  at: number,
  halfLifeMinutes: number | null,
): number | undefined {
  if (reinforcements.length === 0) return undefined;
  if (halfLifeMinutes === null || halfLifeMinutes <= 0) {
    return reinforcements.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  }
  const halfLifeMs = halfLifeMinutes * 60_000;
  return reinforcements.reduce((sum, row) => {
    const elapsed = Math.max(0, at - row.reinforced_at);
    return sum + Math.max(0, row.weight) * Math.exp((-Math.LN2 * elapsed) / halfLifeMs);
  }, 0);
}
