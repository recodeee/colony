import type { ReinforcementKind } from '@colony/storage';
import { inferIdeFromSessionId } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';
import { synthesizePlanFromProposal } from './plan.js';
import type { SignalMetadata } from './signal-metadata.js';
import { signalMetadataFromProposal } from './signal-metadata.js';
import { TaskThread } from './task-thread.js';

export interface PendingProposal {
  id: number;
  summary: string;
  rationale: string;
  touches_files: string[];
  proposed_by: string;
  proposed_at: number;
  strength: number;
  reinforcement_count: number;
  signal_metadata: SignalMetadata;
}

export interface PromotedProposal {
  id: number;
  summary: string;
  task_id: number;
  promoted_at: number;
}

export interface ForagingReport {
  pending: PendingProposal[];
  promoted: PromotedProposal[];
}

/**
 * Proposal system. An agent calls `propose()` when it spots a potential
 * improvement the colony might want to pursue. Other agents call
 * `reinforce()` to support it; the PostToolUse hook also calls
 * `reinforce(..., 'adjacent')` whenever an agent edits a file a pending
 * proposal would touch. Strength is source-diverse: repeated same-session
 * support is collapsed, extra same-agent sessions count moderately, and a
 * different agent type counts fully. When total decayed strength crosses
 * PROMOTION_THRESHOLD, the proposal is auto-promoted into a real task
 * thread agents can join like any other task.
 */
export class ProposalSystem {
  /**
   * Longer half-life than pheromones because ideas are worth remembering
   * longer than edits. A proposal made 30 minutes ago is still potentially
   * a good idea; an edit made 30 minutes ago is stale context.
   */
  private static readonly HALF_LIFE_MS = 60 * 60_000;
  private static readonly DECAY_RATE = Math.LN2 / ProposalSystem.HALF_LIFE_MS;

  /**
   * Reinforcement weights by kind. Rediscovery weighs more than explicit
   * support because independent arrival at the same idea is stronger
   * evidence than a direct "I agree". Adjacency is weak circumstantial
   * support from touching a file the proposal mentions.
   */
  static readonly WEIGHTS: Record<ReinforcementKind, number> = {
    explicit: 1.0,
    rediscovered: 1.2,
    adjacent: 0.3,
  };

  /**
   * Source-diversity multipliers. The first session for an agent type is
   * a distinct source. More sessions from the same agent family still add
   * evidence, but at a lower rate than a different agent type/session.
   * Duplicate reinforcement from the same session is collapsed before
   * these multipliers are applied.
   */
  static readonly DIVERSITY = {
    differentAgentTypeSession: 1.0,
    sameAgentTypeDifferentSession: 0.6,
  } as const;

  /**
   * Total decayed strength required for promotion. 2.5 means roughly
   * "proposer plus one explicit supporter" (1.0 + 1.0 = 2.0, still short;
   * needs a third vote) or "proposer + explicit + a couple adjacencies".
   * Tune after real usage: too low and spurious promotions clog the task
   * list; too high and good ideas never clear the bar.
   */
  static readonly PROMOTION_THRESHOLD = 2.5;

  /**
   * Noise floor for the foraging report. Pending proposals whose strength
   * has decayed below this are effectively evaporated — surface them only
   * in debrief analytics, not in live coordination prefaces.
   */
  static readonly NOISE_FLOOR = 0.3;

  constructor(private store: MemoryStore) {}

  /**
   * Record a new proposal. The proposer is implicitly treated as the first
   * explicit reinforcement — without this, every proposal would start at
   * zero strength and need two other agents to break through the noise
   * floor, which kills the signal in low-participant workflows.
   */
  propose(args: {
    repo_root: string;
    branch: string;
    summary: string;
    rationale: string;
    touches_files: string[];
    session_id: string;
  }): number {
    const now = Date.now();
    const id = this.store.storage.insertProposal({
      repo_root: args.repo_root,
      branch: args.branch,
      summary: args.summary,
      rationale: args.rationale,
      touches_files: JSON.stringify(args.touches_files),
      proposed_by: args.session_id,
      proposed_at: now,
    });
    this.store.storage.insertReinforcement({
      proposal_id: id,
      session_id: args.session_id,
      kind: 'explicit',
      weight: ProposalSystem.WEIGHTS.explicit,
      reinforced_at: now,
    });
    return id;
  }

  /**
   * Add a reinforcement and check for promotion immediately. Promotion is
   * idempotent: a reinforcement arriving after an already-active proposal
   * just accrues without re-creating the task.
   */
  reinforce(args: {
    proposal_id: number;
    session_id: string;
    kind: ReinforcementKind;
  }): { strength: number; promoted: boolean } {
    const now = Date.now();
    const weight = ProposalSystem.WEIGHTS[args.kind];
    if (!this.hasSameSessionWeightAtLeast(args.proposal_id, args.session_id, weight)) {
      this.store.storage.insertReinforcement({
        proposal_id: args.proposal_id,
        session_id: args.session_id,
        kind: args.kind,
        weight,
        reinforced_at: now,
      });
    }
    const strength = this.currentStrength(args.proposal_id);
    const promoted = this.maybePromote(args.proposal_id, strength);
    return { strength, promoted };
  }

  /**
   * Sum of decayed, source-diverse reinforcement weights for a proposal.
   * Each session contributes at most one active signal, repeated same-agent
   * sessions are downweighted, and different agent types retain full weight.
   * Called inline on reinforcement and from the foraging report; O(n) in
   * reinforcement count but n is small (typically under 20) so this stays
   * cheap.
   */
  currentStrength(proposal_id: number): number {
    const now = Date.now();
    const rows = this.store.storage.listReinforcements(proposal_id);
    const proposal = this.store.storage.getProposal(proposal_id);
    const sessionTypes = new Map<string, string>();
    const bySession = new Map<string, SessionEvidence>();

    for (const row of rows) {
      const strength = ProposalSystem.decay(row.weight, row.reinforced_at, now);
      const existing = bySession.get(row.session_id);
      if (
        !existing ||
        strength > existing.strength ||
        (strength === existing.strength && row.reinforced_at > existing.reinforced_at)
      ) {
        bySession.set(row.session_id, {
          session_id: row.session_id,
          agent_type: this.agentTypeForSession(row.session_id, sessionTypes),
          strength,
          reinforced_at: row.reinforced_at,
        });
      }
    }

    return ProposalSystem.applySourceDiversity(
      Array.from(bySession.values()),
      proposal?.proposed_by,
    );
  }

  /**
   * Find proposals on a branch whose touches_files overlap with the given
   * path. Returns only pending proposals — already-promoted ones don't
   * need more reinforcement. Used by PostToolUse to auto-reinforce on
   * adjacent edits.
   */
  pendingProposalsTouching(args: {
    repo_root: string;
    branch: string;
    file_path: string;
  }): number[] {
    const rows = this.store.storage.listProposalsForBranch(args.repo_root, args.branch);
    return rows
      .filter((p) => p.status === 'pending')
      .filter((p) => {
        try {
          const files = JSON.parse(p.touches_files) as unknown;
          return Array.isArray(files) && files.includes(args.file_path);
        } catch {
          return false;
        }
      })
      .map((p) => p.id);
  }

  /**
   * Foraging report for a branch. Pending proposals are filtered below
   * NOISE_FLOOR so evaporated ideas don't pollute the UI. Promoted
   * proposals are separate because they represent in-flight work, not
   * opportunities to support.
   */
  foragingReport(repo_root: string, branch: string): ForagingReport {
    const rows = this.store.storage.listProposalsForBranch(repo_root, branch);
    const pending: PendingProposal[] = [];
    const promoted: PromotedProposal[] = [];

    for (const p of rows) {
      if (p.status === 'active' && p.task_id && p.promoted_at) {
        promoted.push({
          id: p.id,
          summary: p.summary,
          task_id: p.task_id,
          promoted_at: p.promoted_at,
        });
        continue;
      }
      if (p.status !== 'pending') continue;
      const strength = this.currentStrength(p.id);
      if (strength < ProposalSystem.NOISE_FLOOR) continue;
      const reinforcements = this.store.storage.listReinforcements(p.id);
      pending.push({
        id: p.id,
        summary: p.summary,
        rationale: p.rationale,
        touches_files: parseFiles(p.touches_files),
        proposed_by: p.proposed_by,
        proposed_at: p.proposed_at,
        strength,
        reinforcement_count: new Set(reinforcements.map((row) => row.session_id)).size,
        signal_metadata: signalMetadataFromProposal(p, {
          reinforcements,
          strength,
          half_life_minutes: ProposalSystem.HALF_LIFE_MS / 60_000,
        }),
      });
    }

    pending.sort((a, b) => b.strength - a.strength);
    promoted.sort((a, b) => b.promoted_at - a.promoted_at);
    return { pending, promoted };
  }

  /**
   * If strength crosses threshold, open a task thread for this proposal
   * and flip its status to 'active'. Synthetic branch string prevents
   * collision with the source branch's task via the (repo_root, branch)
   * UNIQUE constraint — the promoted task is a sibling, not a replacement.
   */
  private maybePromote(proposal_id: number, strength: number): boolean {
    if (strength < ProposalSystem.PROMOTION_THRESHOLD) return false;
    const proposal = this.store.storage.getProposal(proposal_id);
    if (!proposal || proposal.status !== 'pending') return false;

    const syntheticBranch = `${proposal.branch}/proposal-${proposal_id}`;
    const thread = TaskThread.open(this.store, {
      repo_root: proposal.repo_root,
      branch: syntheticBranch,
      session_id: proposal.proposed_by,
      title: proposal.summary,
    });

    this.store.storage.updateProposal(proposal_id, {
      status: 'active',
      promoted_at: Date.now(),
      task_id: thread.task_id,
    });

    // Bridge: also synthesize a "lite" plan so the Plans page surfaces the
    // promoted task with sub-task progress tracking. The promotion
    // (TaskThread + status flip) is the load-bearing contract; this is a
    // bonus. If synthesis throws — schema drift, partition edge case, etc.
    // — we log and continue so a buggy bridge can't unwind a successful
    // promotion. The proposal.status flip above is the idempotency anchor:
    // a re-entry of this method returns false at the status guard before
    // ever calling synthesize again.
    try {
      synthesizePlanFromProposal(this.store, {
        id: proposal.id,
        repo_root: proposal.repo_root,
        summary: proposal.summary,
        rationale: proposal.rationale,
        touches_files: proposal.touches_files,
        proposed_by: proposal.proposed_by,
      });
    } catch (err) {
      this.store.addObservation({
        session_id: proposal.proposed_by,
        task_id: thread.task_id,
        kind: 'plan-synthesis-failed',
        content: `bridge failed: ${err instanceof Error ? err.message : String(err)}`,
        metadata: {
          promoted_from_proposal_id: proposal.id,
        },
      });
    }

    return true;
  }

  private hasSameSessionWeightAtLeast(
    proposal_id: number,
    session_id: string,
    weight: number,
  ): boolean {
    return this.store.storage
      .listReinforcements(proposal_id)
      .some((row) => row.session_id === session_id && row.weight >= weight);
  }

  private agentTypeForSession(session_id: string, cache: Map<string, string>): string {
    const cached = cache.get(session_id);
    if (cached) return cached;

    const session = this.store.storage.getSession(session_id);
    const type =
      agentTypeFromMetadata(session?.metadata) ??
      normalizeAgentType(session?.ide) ??
      normalizeAgentType(inferIdeFromSessionId(session_id)) ??
      'unknown';
    cache.set(session_id, type);
    return type;
  }

  private static decay(weight: number, reinforcedAt: number, now: number): number {
    const elapsed = now - reinforcedAt;
    if (elapsed <= 0) return weight;
    return weight * Math.exp(-ProposalSystem.DECAY_RATE * elapsed);
  }

  private static applySourceDiversity(
    entries: SessionEvidence[],
    proposedBy: string | undefined,
  ): number {
    const byAgentType = new Map<string, SessionEvidence[]>();
    for (const entry of entries) {
      const group = byAgentType.get(entry.agent_type) ?? [];
      group.push(entry);
      byAgentType.set(entry.agent_type, group);
    }

    let total = 0;
    for (const group of byAgentType.values()) {
      group.sort(compareEvidence);
      const proposerIndex =
        proposedBy === undefined ? -1 : group.findIndex((entry) => entry.session_id === proposedBy);

      if (proposerIndex >= 0) {
        const [proposer] = group.splice(proposerIndex, 1);
        if (proposer) total += proposer.strength;
      } else {
        const first = group.shift();
        if (first) total += first.strength * ProposalSystem.DIVERSITY.differentAgentTypeSession;
      }

      for (const entry of group) {
        total += entry.strength * ProposalSystem.DIVERSITY.sameAgentTypeDifferentSession;
      }
    }

    return total;
  }
}

interface SessionEvidence {
  session_id: string;
  agent_type: string;
  strength: number;
  reinforced_at: number;
}

function compareEvidence(a: SessionEvidence, b: SessionEvidence): number {
  return (
    b.strength - a.strength ||
    b.reinforced_at - a.reinforced_at ||
    a.session_id.localeCompare(b.session_id)
  );
}

function parseFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function agentTypeFromMetadata(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    for (const key of ['agent', 'agentName', 'agent_name', 'ide', 'cliName', 'cli_name']) {
      const normalized = normalizeAgentType(record[key]);
      if (normalized) return normalized;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeAgentType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') return undefined;
  if (normalized === 'claude-code' || normalized === 'claudecode') return 'claude';
  return normalized;
}
