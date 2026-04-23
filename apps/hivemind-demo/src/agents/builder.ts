import { findLatestArtifact } from '../core/state.js';
import type {
  Agent,
  AgentInput,
  AgentResult,
  BuildArtifactContent,
  ResearchArtifactContent,
  ReviewArtifactContent,
  RunState,
} from '../core/types.js';

const BASE_FILE_TREE = [
  'src/agents/coordinator.ts',
  'src/agents/researcher.ts',
  'src/agents/builder.ts',
  'src/agents/reviewer.ts',
  'src/agents/verifier.ts',
  'src/core/orchestrator.ts',
  'src/core/state.ts',
  'src/core/checkpoint.ts',
  'src/core/types.ts',
  'src/cli/index.ts',
  'src/index.ts',
  'src/utils/logger.ts',
  'src/utils/ids.ts',
  'test/orchestrator.test.ts',
  'README.md',
  'data/runs/.gitkeep',
];

export class BuilderAgent implements Agent {
  readonly name = 'Builder';
  readonly role = 'builder' as const;

  run(input: AgentInput, state: RunState): AgentResult {
    const research = findLatestArtifact<ResearchArtifactContent>(state, 'research')?.content;
    const priorReview = findLatestArtifact<ReviewArtifactContent>(state, 'review')?.content;
    const revisionNotes =
      input.attempt > 1 && priorReview ? priorReview.requiredFixes.map((issue) => `Address review feedback: ${issue}`) : [];

    const content: BuildArtifactContent = {
      fileTree: [...BASE_FILE_TREE],
      implementationSteps: [
        'Define core types for run state, subtasks, artifacts, checkpoints, and final output.',
        'Persist `state.json` after every agent step under `data/runs/<run-id>/`.',
        'Run coordinator -> researcher -> builder -> reviewer -> verifier with max-turn and retry guards.',
        'Create compact checkpoints every few steps so workers share only Goal / Done / Blocker / Next.',
        'Require verifier approval before final success is emitted.',
      ],
      testPlan: [
        'Happy path: orchestrator completes a bounded task and writes checkpoints.',
        'Failure path: reviewer rejects a build with no test plan or checkpoint policy.',
        'CLI path: the command prints run status, result, and run directory.',
      ],
      checkpointPolicy: [
        'Default checkpoint interval = 2 agent steps.',
        'Checkpoint payload carries Goal, Done, Current blocker, and Next batch only.',
        'Coordinator decisions consume checkpoints and active blockers instead of raw history.',
      ],
      notes: unique([
        ...(research?.recommendedFocus ?? []),
        ...revisionNotes,
        'Provider and tool interfaces stay swappable for future real integrations.',
      ]),
    };

    return {
      status: 'completed',
      summary: `Builder produced attempt ${input.attempt} with ${content.fileTree.length} files in scope.`,
      details: [
        content.implementationSteps[0] ?? '',
        content.implementationSteps[1] ?? '',
        content.testPlan[0] ?? '',
      ].filter(Boolean),
      artifact: {
        type: 'build',
        label: input.attempt > 1 ? `build-attempt-${input.attempt}` : 'initial-build',
        content,
      },
      markSubtasks: [
        { id: 'build', status: 'completed', note: `Builder attempt ${input.attempt} ready for review.` },
        { id: 'review', status: 'in_progress', note: 'Reviewing current build.' },
      ],
      replaceBlockers: [],
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
