import { findLatestArtifact } from '../core/state.js';
import type {
  Agent,
  AgentInput,
  AgentResult,
  BuildArtifactContent,
  ReviewArtifactContent,
  RunState,
} from '../core/types.js';

const REQUIRED_FILES = [
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
  'README.md',
  'test/orchestrator.test.ts',
];

export class ReviewerAgent implements Agent {
  readonly name = 'Reviewer';
  readonly role = 'reviewer' as const;

  run(_input: AgentInput, state: RunState): AgentResult {
    const build = findLatestArtifact<BuildArtifactContent>(state, 'build')?.content;
    if (!build) {
      return {
        status: 'blocked',
        summary: 'Reviewer missing build artifact.',
        details: ['Builder must run before reviewer.'],
        replaceBlockers: ['Build artifact missing.'],
        markSubtasks: [{ id: 'review', status: 'blocked', note: 'No build artifact found.' }],
      };
    }

    const issues: string[] = [];
    for (const requiredFile of REQUIRED_FILES) {
      if (!build.fileTree.includes(requiredFile)) {
        issues.push(`Missing required file: ${requiredFile}`);
      }
    }
    if (build.implementationSteps.length < 4) {
      issues.push('Implementation steps are too thin.');
    }
    if (build.testPlan.length === 0) {
      issues.push('Test plan missing.');
    }
    if (build.checkpointPolicy.length === 0) {
      issues.push('Checkpoint policy missing.');
    }

    const strengths = [
      `File tree covers ${build.fileTree.length} entries.`,
      `Implementation plan has ${build.implementationSteps.length} steps.`,
      `Test plan has ${build.testPlan.length} verification item(s).`,
      `Checkpoint policy has ${build.checkpointPolicy.length} rule(s).`,
    ];
    const approved = issues.length === 0;
    const content: ReviewArtifactContent = {
      approved,
      strengths,
      issues,
      requiredFixes: issues,
    };

    return {
      status: approved ? 'completed' : 'blocked',
      summary: approved ? 'Reviewer approved builder output.' : `Reviewer found ${issues.length} gap(s).`,
      details: approved ? strengths.slice(0, 3) : issues,
      artifact: {
        type: 'review',
        label: approved ? 'review-approved' : 'review-needs-work',
        content,
      },
      markSubtasks: [
        {
          id: 'review',
          status: approved ? 'completed' : 'blocked',
          note: approved ? 'Ready for verifier.' : 'Builder revision required.',
        },
      ],
      replaceBlockers: approved ? [] : issues,
    };
  }
}
