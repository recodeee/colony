import { findLatestArtifact } from '../core/state.js';
import type {
  Agent,
  AgentInput,
  AgentResult,
  FinalOutput,
  ReviewArtifactContent,
  RunState,
  VerificationArtifactContent,
} from '../core/types.js';

export class VerifierAgent implements Agent {
  readonly name = 'Verifier';
  readonly role = 'verifier' as const;

  run(_input: AgentInput, state: RunState): AgentResult {
    const blockers: string[] = [];
    const review = findLatestArtifact<ReviewArtifactContent>(state, 'review')?.content;

    if (!review) {
      blockers.push('Review artifact missing.');
    } else if (!review.approved) {
      blockers.push('Latest review is not approved.');
    }
    if (state.currentPlan.length === 0) {
      blockers.push('Coordinator plan missing.');
    }
    if (state.checkpoints.length === 0) {
      blockers.push('Checkpoint history missing.');
    }
    if (!findLatestArtifact(state, 'research')) {
      blockers.push('Research artifact missing.');
    }
    if (!findLatestArtifact(state, 'build')) {
      blockers.push('Build artifact missing.');
    }

    const evidence = [
      `Plan steps: ${state.currentPlan.length}`,
      `Artifacts captured: ${state.artifacts.length}`,
      `Checkpoints captured: ${state.checkpoints.length}`,
      `Retry count: ${state.retryCount}`,
    ];

    if (blockers.length > 0) {
      const blockedContent: VerificationArtifactContent = {
        approved: false,
        evidence,
        openRisks: ['Run stopped before the verifier could approve final success.'],
        nextSteps: ['Resolve blockers and rerun verifier.'],
      };

      return {
        status: 'blocked',
        summary: 'Verifier blocked final success.',
        details: blockers,
        artifact: {
          type: 'verification',
          label: 'verifier-blocked',
          content: blockedContent,
        },
        replaceBlockers: blockers,
        runStatus: 'blocked',
        markSubtasks: [{ id: 'verify', status: 'blocked', note: 'Verification failed.' }],
      };
    }

    const openRisks = [
      'Agent behavior is deterministic and does not yet exercise real model quality.',
      'The MVP stays sequential; parallel dispatch and conflict handling are future work.',
    ];
    const nextSteps = [
      'Swap deterministic agent bodies with a real `ModelProvider` implementation.',
      'Attach `ToolRunner` adapters for file, web, and code tools.',
      'Track eval metrics like turns, retries, and checkpoint counts across many runs.',
    ];
    const finalResult: FinalOutput = {
      result: `Completed verified hivemind run for: ${state.originalTask}`,
      reasoningSummary: [
        'Coordinator created a bounded research/build/review/verify loop.',
        'Researcher translated the raw task into constraints and focus areas.',
        'Builder produced a concrete file tree, implementation plan, test plan, and checkpoint policy.',
        'Reviewer approved the proposal before verifier closed the run.',
      ],
      openRisks,
      nextSteps,
      verified: true,
    };
    const verificationContent: VerificationArtifactContent = {
      approved: true,
      evidence,
      openRisks,
      nextSteps,
    };

    return {
      status: 'completed',
      summary: 'Verifier approved final output.',
      details: evidence,
      artifact: {
        type: 'verification',
        label: 'verifier-report',
        content: verificationContent,
      },
      finalResult,
      runStatus: 'completed',
      replaceBlockers: [],
      markSubtasks: [{ id: 'verify', status: 'completed', note: `Verified with ${state.checkpoints.length} checkpoint(s).` }],
    };
  }
}
