import type { ReinforcementKind } from '@colony/storage';
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
 * proposal would touch. When total decayed strength crosses
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
   * Reinforcement weights by kind. Explicit support weighs most because
   * the supporter consciously chose; rediscovery next (independent arrival
   * at the same idea is strong evidence); adjacency least (editing a file
   * the proposal touches is only weak circumstantial support).
   */
  static readonly WEIGHTS: Record<ReinforcementKind, number> = {
    explicit: 1.0,
    rediscovered: 0.7,
    adjacent: 0.3,
  };

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
    this.store.storage.insertReinforcement({
      proposal_id: args.proposal_id,
      session_id: args.session_id,
      kind: args.kind,
      weight: ProposalSystem.WEIGHTS[args.kind],
      reinforced_at: now,
    });
    const strength = this.currentStrength(args.proposal_id);
    const promoted = this.maybePromote(args.proposal_id, strength);
    return { strength, promoted };
  }

  /**
   * Sum of decayed reinforcement weights for a proposal. Called inline on
   * reinforcement and from the foraging report; O(n) in reinforcement
   * count but n is small (typically under 20) so this stays cheap.
   */
  currentStrength(proposal_id: number): number {
    const now = Date.now();
    const rows = this.store.storage.listReinforcements(proposal_id);
    return rows.reduce((sum, r) => {
      const elapsed = now - r.reinforced_at;
      if (elapsed <= 0) return sum + r.weight;
      return sum + r.weight * Math.exp(-ProposalSystem.DECAY_RATE * elapsed);
    }, 0);
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
        reinforcement_count: reinforcements.length,
        signal_metadata: signalMetadataFromProposal(p, {
          reinforcements,
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
}

function parseFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
