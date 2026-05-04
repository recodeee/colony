import { countTokens } from '@colony/compress';
import type { ObservationRow, SessionRow, Storage, SummaryRow } from '@colony/storage';
import { agentFromIde, inferIdeFromSessionId } from './infer-ide.js';

export interface CocoIndexSessionSourceOptions {
  agents?: string[];
  limit?: number;
  timelineLimit?: number;
  maxContextChars?: number;
}

export interface CocoIndexSessionRecord {
  id: string;
  ide: string;
  agent: string;
  cwd: string | null;
  started_at: number;
  ended_at: number | null;
  observation_count: number;
  summary_count: number;
  tokens_before: number;
  tokens_after: number;
  saved_tokens: number;
  saved_ratio: number;
  compact_tokens: number;
  compact_context: string;
}

const DEFAULT_AGENTS = ['codex', 'claude'];
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMELINE_LIMIT = 80;
const DEFAULT_MAX_CONTEXT_CHARS = 1200;

export function buildCocoIndexSessionRecords(
  storage: Storage,
  options: CocoIndexSessionSourceOptions = {},
): CocoIndexSessionRecord[] {
  const agents = normalizeAgents(options.agents ?? DEFAULT_AGENTS);
  const limit = normalizePositiveInt(options.limit, DEFAULT_LIMIT);
  const timelineLimit = normalizePositiveInt(options.timelineLimit, DEFAULT_TIMELINE_LIMIT);
  const maxContextChars = normalizePositiveInt(options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS);

  return storage
    .listSessions(limit)
    .map((session) => {
      const agent = sessionAgent(session);
      return { session, agent };
    })
    .filter((entry) => agents.has(entry.agent))
    .map(({ session, agent }) => {
      const observations = storage.timeline(session.id, undefined, timelineLimit);
      const summaries = storage.listSummaries(session.id);
      const compactContext = compactSessionContext(summaries, observations, maxContextChars);
      const tokenStats = tokenStatsFor(observations);
      return {
        id: session.id,
        ide: session.ide,
        agent,
        cwd: session.cwd,
        started_at: session.started_at,
        ended_at: session.ended_at,
        observation_count: observations.length,
        summary_count: summaries.length,
        tokens_before: tokenStats.tokens_before,
        tokens_after: tokenStats.tokens_after,
        saved_tokens: tokenStats.saved_tokens,
        saved_ratio:
          tokenStats.tokens_before === 0
            ? 0
            : normalizeRatio(tokenStats.saved_tokens / tokenStats.tokens_before),
        compact_tokens: countTokens(compactContext),
        compact_context: compactContext,
      };
    });
}

export function safeCocoIndexSessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'session'}.json`;
}

function sessionAgent(session: SessionRow): string {
  return (
    agentFromIde(session.ide) ?? agentFromIde(inferIdeFromSessionId(session.id) ?? '') ?? 'unknown'
  );
}

function normalizeAgents(agents: string[]): Set<string> {
  const out = new Set<string>();
  for (const agent of agents) {
    const normalized = agentFromIde(agent) ?? agent.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out.size > 0 ? out : new Set(DEFAULT_AGENTS);
}

function compactSessionContext(
  summaries: SummaryRow[],
  observations: ObservationRow[],
  maxChars: number,
): string {
  const summaryText = summaries
    .slice(0, 3)
    .map((row) => row.content.trim())
    .filter(Boolean)
    .join('\n---\n');
  const source =
    summaryText ||
    observations
      .slice(0, 8)
      .map((row) => `${row.kind}: ${row.content.trim()}`)
      .filter((line) => line.length > 0)
      .join('\n');
  return source.length <= maxChars ? source : source.slice(0, maxChars).trimEnd();
}

function tokenStatsFor(observations: ObservationRow[]): {
  tokens_before: number;
  tokens_after: number;
  saved_tokens: number;
} {
  return observations.reduce(
    (acc, row) => {
      const metadata = parseMetadata(row.metadata);
      const before = readNumber(metadata, 'tokens_before');
      const after = readNumber(metadata, 'tokens_after');
      const saved = readNumber(metadata, 'saved_tokens');
      if (before !== null) acc.tokens_before += before;
      if (after !== null) acc.tokens_after += after;
      if (saved !== null) acc.saved_tokens += saved;
      return acc;
    },
    { tokens_before: 0, tokens_after: 0, saved_tokens: 0 },
  );
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeRatio(value: number): number {
  return Object.is(value, -0) ? 0 : Number(value.toFixed(3));
}
