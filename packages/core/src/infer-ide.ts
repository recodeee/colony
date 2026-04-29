/**
 * Best-effort mapping from a session id to the IDE / agent that created it.
 *
 * Hooks write `ide = input.ide ?? infer(session_id) ?? 'unknown'`. Without a
 * broad matcher, ids like `codex-colony-usage-limit-takeover-verify-...` — the
 * hyphen-delimited task-named sessions codex emits — fell through and landed
 * in storage as `unknown`. The viewer then shows every such row as an
 * unowned session, making it impossible to tell who ran what.
 *
 * Keep this list conservative: prefix inference is a heuristic, so we only
 * return a known IDE id and never guess from arbitrary strings.
 */
export function inferIdeFromSessionId(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const parts = sessionId.split(/[@\-:/_]/).map((p) => p.toLowerCase());
  const first = parts[0];
  if (!first) return undefined;
  // When an agent writes its session id using the Guardex branch form
  // (`agent/<name>/<task-slug>`), the literal leading segment is `agent`
  // and the IDE name lives in the second segment. Peel that off before
  // the normal prefix match so those rows get classified instead of
  // landing in storage as `unknown`.
  const candidate = first === 'agent' && parts[1] ? parts[1] : first;
  switch (candidate) {
    case 'claude':
    case 'claudecode':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'cursor':
      return 'cursor';
    case 'windsurf':
      return 'windsurf';
    case 'aider':
      return 'aider';
    default:
      return undefined;
  }
}

export interface SessionIdentityInference {
  inferred_agent: string;
  ide: string;
  confidence: number;
  source: string;
}

export interface SessionIdentityEvidence {
  sessionId?: string | null;
  ide?: string | null;
  cli?: string | null;
  agent?: string | null;
  branch?: string | null;
  cwd?: string | null;
  worktreePath?: string | null;
  metadata?: Record<string, unknown> | null;
  sourceHint?: string | null;
}

export const UNBOUND_AGENT = 'unbound';

const NON_IDENTITY_VALUES = new Set([
  '',
  'agent',
  'unknown',
  'unknown-session',
  'unbound',
  'null',
  'undefined',
]);

export function inferSessionIdentity(evidence: SessionIdentityEvidence): SessionIdentityInference {
  const sourceHint = normalizedSource(evidence.sourceHint);
  const metadata = evidence.metadata ?? undefined;
  const explicitIde = firstConcrete(evidence.ide, evidence.cli);
  const fromIde = identityFromIde(explicitIde, sourceHint, 'explicit-ide', 1);
  if (fromIde) return fromIde;

  const explicitAgent = firstConcrete(
    evidence.agent,
    readMetadataString(metadata, 'inferred_agent'),
    readMetadataString(metadata, 'source_agent'),
    readMetadataString(metadata, 'from_agent'),
    readMetadataString(metadata, 'agent'),
    readMetadataString(metadata, 'agentName'),
    readMetadataString(metadata, 'agent_name'),
  );
  const fromAgent = identityFromAgent(explicitAgent, sourceHint, 'agent', 0.95);
  if (fromAgent) return fromAgent;

  const fromSessionId = identityFromIde(
    inferIdeFromSessionId(cleanString(evidence.sessionId)),
    sourceHint,
    'session-id',
    0.85,
  );
  if (fromSessionId) return fromSessionId;

  const fromBranch = identityFromAgent(
    inferAgentFromBranch(cleanString(evidence.branch)),
    sourceHint,
    'branch',
    0.7,
  );
  if (fromBranch) return fromBranch;

  const fromWorktree = identityFromAgent(
    inferAgentFromWorktreePath(firstConcrete(evidence.worktreePath, evidence.cwd) ?? ''),
    sourceHint,
    'worktree-path',
    0.65,
  );
  if (fromWorktree) return fromWorktree;

  return {
    inferred_agent: UNBOUND_AGENT,
    ide: 'unknown',
    confidence: 0,
    source: prefixedSource(sourceHint, 'unbound'),
  };
}

export function sessionIdentityMetadata(
  inference: SessionIdentityInference,
): Record<string, unknown> {
  return {
    inferred_agent: inference.inferred_agent,
    confidence: inference.confidence,
    source: inference.source,
  };
}

export function agentFromIde(ide: string): string | undefined {
  const normalized = cleanString(ide);
  if (isNonIdentityValue(normalized)) return undefined;
  if (normalized === 'claude-code' || normalized === 'claudecode' || normalized === 'claude') {
    return 'claude';
  }
  return normalized;
}

export function ideFromAgent(agent: string): string | undefined {
  const normalized = cleanString(agent);
  if (isNonIdentityValue(normalized)) return undefined;
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'claude-code') {
    return 'claude-code';
  }
  return normalized;
}

export function inferAgentFromBranch(branch: string): string | undefined {
  const parts = cleanString(branch).split('/').filter(Boolean);
  if (parts[0] !== 'agent') return undefined;
  return agentFromIde(parts[1] ?? '');
}

export function inferAgentFromWorktreePath(path: string): string | undefined {
  const match = cleanString(path).match(/(?:^|[/\\])[^/\\]*__([a-z][a-z0-9-]*)__/i);
  return match?.[1] ? agentFromIde(match[1]) : undefined;
}

export function isNonIdentityValue(value: string): boolean {
  return NON_IDENTITY_VALUES.has(cleanString(value));
}

function identityFromIde(
  ide: string | undefined,
  sourceHint: string,
  source: string,
  confidence: number,
): SessionIdentityInference | undefined {
  const normalizedIde = ideFromAgent(ide ?? '');
  if (!normalizedIde) return undefined;
  const inferredAgent = agentFromIde(normalizedIde);
  if (!inferredAgent) return undefined;
  return {
    inferred_agent: inferredAgent,
    ide: normalizedIde,
    confidence,
    source: prefixedSource(sourceHint, source),
  };
}

function identityFromAgent(
  agent: string | undefined,
  sourceHint: string,
  source: string,
  confidence: number,
): SessionIdentityInference | undefined {
  const ide = ideFromAgent(agent ?? '');
  if (!ide) return undefined;
  return identityFromIde(ide, sourceHint, source, confidence);
}

function firstConcrete(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const text = cleanString(value);
    if (!isNonIdentityValue(text)) return text;
  }
  return undefined;
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function cleanString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizedSource(value: string | null | undefined): string {
  return cleanString(value).replace(/[^a-z0-9_.:-]+/g, '-');
}

function prefixedSource(prefix: string, source: string): string {
  return prefix ? `${prefix}:${source}` : source;
}
