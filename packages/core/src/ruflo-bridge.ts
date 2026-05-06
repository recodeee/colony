const CONTENT_FIELD_LIMIT = 160;
const CONTENT_LIMIT = 700;

export const RUFLO_BRIDGE_EVENT_FAMILIES = [
  'agent',
  'swarm',
  'tasks',
  'memory',
  'hooks',
  'federation',
  'tools',
] as const;

export type RufloBridgeEventFamily = (typeof RUFLO_BRIDGE_EVENT_FAMILIES)[number];

export const RUFLO_BRIDGE_EVENT_NAMES = [
  'agent/start',
  'agent/finish',
  'agent/error',
  'swarm/task-assigned',
  'swarm/task-completed',
  'tasks/created',
  'tasks/blocked',
  'memory/write',
  'memory/search',
  'hooks/pre',
  'hooks/post',
  'federation/handoff',
  'tools/call',
  'tools/result',
] as const;

export type RufloBridgeEventName = (typeof RUFLO_BRIDGE_EVENT_NAMES)[number];

export const RUFLO_BRIDGE_EVENT_FAMILY_BY_NAME = {
  'agent/start': 'agent',
  'agent/finish': 'agent',
  'agent/error': 'agent',
  'swarm/task-assigned': 'swarm',
  'swarm/task-completed': 'swarm',
  'tasks/created': 'tasks',
  'tasks/blocked': 'tasks',
  'memory/write': 'memory',
  'memory/search': 'memory',
  'hooks/pre': 'hooks',
  'hooks/post': 'hooks',
  'federation/handoff': 'federation',
  'tools/call': 'tools',
  'tools/result': 'tools',
} as const satisfies Record<RufloBridgeEventName, RufloBridgeEventFamily>;

export type RufloBridgeEventFamilyForName<Name extends RufloBridgeEventName> =
  (typeof RUFLO_BRIDGE_EVENT_FAMILY_BY_NAME)[Name];

export interface RufloBridgeEvent<Name extends RufloBridgeEventName = RufloBridgeEventName> {
  name: Name;
  family?: RufloBridgeEventFamilyForName<Name>;
  run_id?: string;
  agent_id?: string;
  task_id?: number | string;
  repo_root?: string;
  success?: boolean;
  duration_ms?: number;
  summary?: string;
  pattern?: string;
  confidence?: number;
  domain?: string;
  quality?: number;
  payload?: unknown;
  body?: unknown;
}

export interface RufloBridgeObservationMetadata {
  ruflo_event_family: RufloBridgeEventFamily;
  ruflo_event_name: RufloBridgeEventName;
  ruflo_run_id?: string;
  ruflo_agent_id?: string;
  task_id?: number | string;
  repo_root?: string;
  success?: boolean;
  duration_ms?: number;
}

export interface RufloBridgeObservation {
  kind: 'ruflo-bridge';
  content: string;
  metadata: RufloBridgeObservationMetadata;
  task_id?: number;
}

export type RufloDerivedObservationKind = 'task-outcome' | 'learned-pattern';

export interface RufloDerivedObservationMetadata extends RufloBridgeObservationMetadata {
  source: 'ruflo';
  ruflo_observation_kind: RufloDerivedObservationKind;
  confidence?: number;
  domain?: string;
  quality?: number;
}

export interface RufloDerivedObservation {
  kind: RufloDerivedObservationKind;
  content: string;
  metadata: RufloDerivedObservationMetadata;
  task_id?: number;
}

export type RufloBridgeMappedObservation = RufloBridgeObservation | RufloDerivedObservation;

interface RufloBridgeObservationMetadataDraft {
  ruflo_event_family: RufloBridgeEventFamily;
  ruflo_event_name: RufloBridgeEventName;
  ruflo_run_id?: string | undefined;
  ruflo_agent_id?: string | undefined;
  task_id?: number | string | undefined;
  repo_root?: string | undefined;
  success?: boolean | undefined;
  duration_ms?: number | undefined;
}

export function mapRufloEventToColonyObservation(event: RufloBridgeEvent): RufloBridgeObservation {
  const family = event.family ?? RUFLO_BRIDGE_EVENT_FAMILY_BY_NAME[event.name];
  const metadata = compactMetadata({
    ruflo_event_family: family,
    ruflo_event_name: event.name,
    ruflo_run_id: optionalString(event.run_id),
    ruflo_agent_id: optionalString(event.agent_id),
    task_id: optionalTaskId(event.task_id),
    repo_root: optionalString(event.repo_root),
    success: typeof event.success === 'boolean' ? event.success : undefined,
    duration_ms:
      typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms)
        ? event.duration_ms
        : undefined,
  });
  const observation: RufloBridgeObservation = {
    kind: 'ruflo-bridge',
    content: compactContent(event, metadata),
    metadata,
  };
  if (typeof metadata.task_id === 'number' && Number.isInteger(metadata.task_id)) {
    observation.task_id = metadata.task_id;
  }
  return observation;
}

export function mapRufloEventToColonyObservations(
  event: RufloBridgeEvent,
): RufloBridgeMappedObservation[] {
  const base = mapRufloEventToColonyObservation(event);
  return [base, ...deriveRufloLearningObservations(event, base.metadata)];
}

export function deriveRufloLearningObservations(
  event: RufloBridgeEvent,
  metadata = mapRufloEventToColonyObservation(event).metadata,
): RufloDerivedObservation[] {
  const observations: RufloDerivedObservation[] = [];
  if (
    event.name === 'swarm/task-completed' ||
    event.name === 'agent/finish' ||
    event.name === 'agent/error'
  ) {
    const taskOutcome = derivedTaskOutcomeObservation(event, metadata);
    if (taskOutcome) observations.push(taskOutcome);
  }
  if (event.name === 'memory/write') {
    const learnedPattern = derivedLearnedPatternObservation(event, metadata);
    if (learnedPattern) observations.push(learnedPattern);
  }
  return observations;
}

function derivedTaskOutcomeObservation(
  event: RufloBridgeEvent,
  metadata: RufloBridgeObservationMetadata,
): RufloDerivedObservation | null {
  if (
    metadata.task_id === undefined &&
    metadata.success === undefined &&
    metadata.duration_ms === undefined &&
    !event.summary
  ) {
    return null;
  }
  return {
    kind: 'task-outcome',
    content: compactText(
      [
        'ruflo task outcome:',
        `event=${metadata.ruflo_event_name}`,
        metadata.task_id !== undefined ? `task=${metadata.task_id}` : '',
        metadata.success !== undefined ? `success=${metadata.success}` : '',
        metadata.duration_ms !== undefined ? `duration_ms=${metadata.duration_ms}` : '',
        event.summary ? `summary=${compactText(event.summary, CONTENT_FIELD_LIMIT)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      CONTENT_LIMIT,
    ),
    metadata: compactDerivedMetadata(metadata, event, 'task-outcome'),
    ...(typeof metadata.task_id === 'number' && Number.isInteger(metadata.task_id)
      ? { task_id: metadata.task_id }
      : {}),
  };
}

function derivedLearnedPatternObservation(
  event: RufloBridgeEvent,
  metadata: RufloBridgeObservationMetadata,
): RufloDerivedObservation | null {
  const pattern = optionalString(event.pattern) ?? optionalString(event.summary);
  if (!pattern) return null;
  return {
    kind: 'learned-pattern',
    content: compactText(
      [
        'ruflo learned pattern:',
        `pattern=${compactText(pattern, CONTENT_FIELD_LIMIT)}`,
        event.domain ? `domain=${compactText(event.domain, CONTENT_FIELD_LIMIT)}` : '',
        typeof event.confidence === 'number' && Number.isFinite(event.confidence)
          ? `confidence=${event.confidence}`
          : '',
        typeof event.quality === 'number' && Number.isFinite(event.quality)
          ? `quality=${event.quality}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      CONTENT_LIMIT,
    ),
    metadata: compactDerivedMetadata(metadata, event, 'learned-pattern'),
    ...(typeof metadata.task_id === 'number' && Number.isInteger(metadata.task_id)
      ? { task_id: metadata.task_id }
      : {}),
  };
}

function compactDerivedMetadata(
  metadata: RufloBridgeObservationMetadata,
  event: RufloBridgeEvent,
  kind: RufloDerivedObservationKind,
): RufloDerivedObservationMetadata {
  return {
    ...metadata,
    source: 'ruflo',
    ruflo_observation_kind: kind,
    ...(typeof event.confidence === 'number' && Number.isFinite(event.confidence)
      ? { confidence: event.confidence }
      : {}),
    ...(event.domain ? { domain: compactText(event.domain, CONTENT_FIELD_LIMIT) } : {}),
    ...(typeof event.quality === 'number' && Number.isFinite(event.quality)
      ? { quality: event.quality }
      : {}),
  };
}

function compactContent(event: RufloBridgeEvent, metadata: RufloBridgeObservationMetadata): string {
  const parts = [
    `event=${metadata.ruflo_event_name}`,
    metadata.ruflo_run_id ? `run=${metadata.ruflo_run_id}` : '',
    metadata.ruflo_agent_id ? `agent=${metadata.ruflo_agent_id}` : '',
    metadata.task_id !== undefined ? `task=${metadata.task_id}` : '',
    metadata.repo_root ? `repo=${metadata.repo_root}` : '',
    metadata.success !== undefined ? `success=${metadata.success}` : '',
    metadata.duration_ms !== undefined ? `duration_ms=${metadata.duration_ms}` : '',
    event.summary ? `summary=${compactText(event.summary, CONTENT_FIELD_LIMIT)}` : '',
  ].filter(Boolean);
  return compactText(`ruflo bridge: ${parts.join('; ')}`, CONTENT_LIMIT);
}

function compactMetadata(
  metadata: RufloBridgeObservationMetadataDraft,
): RufloBridgeObservationMetadata {
  const compacted: RufloBridgeObservationMetadata = {
    ruflo_event_family: metadata.ruflo_event_family,
    ruflo_event_name: metadata.ruflo_event_name,
  };
  if (metadata.ruflo_run_id) compacted.ruflo_run_id = metadata.ruflo_run_id;
  if (metadata.ruflo_agent_id) compacted.ruflo_agent_id = metadata.ruflo_agent_id;
  if (metadata.task_id !== undefined) compacted.task_id = metadata.task_id;
  if (metadata.repo_root) compacted.repo_root = metadata.repo_root;
  if (metadata.success !== undefined) compacted.success = metadata.success;
  if (metadata.duration_ms !== undefined) compacted.duration_ms = metadata.duration_ms;
  return compacted;
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const compacted = compactText(value, CONTENT_FIELD_LIMIT);
  return compacted || undefined;
}

function optionalTaskId(value: number | string | undefined): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return optionalString(value);
}

function compactText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}
