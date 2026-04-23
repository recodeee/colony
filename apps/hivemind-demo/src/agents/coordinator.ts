import { findLatestArtifact } from '../core/state.js';
import type {
  Agent,
  AgentInput,
  AgentResult,
  PlanArtifactContent,
  ReviewArtifactContent,
  RunState,
  RunSubtask,
} from '../core/types.js';

export class CoordinatorAgent implements Agent {
  readonly name = 'Coordinator';
  readonly role = 'coordinator' as const;

  run(input: AgentInput, state: RunState): AgentResult {
    if (input.phase === 'plan') {
      const focus = detectFocus(input.task);
      const subtasks = createSubtasks();
      const steps = [
        'Research constraints and active requirements from the user task.',
        'Build one bounded implementation package with explicit file ownership.',
        'Review the build for gaps, risks, and missing verification.',
        'Verify the run before returning a final result.',
      ];
      const artifact: PlanArtifactContent = {
        focus,
        steps,
        subtasks: subtasks.map(({ id, title, owner }) => ({ id, title, owner })),
      };

      return {
        status: 'completed',
        summary: `Coordinator planned a ${steps.length}-step hivemind loop.`,
        details: focus,
        artifact: {
          type: 'plan',
          label: 'coordinator-plan',
          content: artifact,
        },
        plan: {
          steps,
          subtasks,
        },
      };
    }

    const review = findLatestArtifact<ReviewArtifactContent>(state, 'review')?.content;
    if (!review) {
      return {
        status: 'blocked',
        summary: 'Coordinator cannot decide without reviewer output.',
        details: ['Review artifact missing.'],
        replaceBlockers: ['Review artifact missing.'],
        decision: 'escalate',
        runStatus: 'blocked',
      };
    }

    if (review.approved) {
      return {
        status: 'completed',
        summary: 'Coordinator sends approved build to verifier.',
        details: review.strengths,
        replaceBlockers: [],
        decision: 'send_to_verifier',
        markSubtasks: [
          { id: 'review', status: 'completed', note: 'Review approved.' },
          { id: 'verify', status: 'in_progress', note: 'Verifier ready.' },
        ],
      };
    }

    if (state.retryCount < state.maxRetries) {
      return {
        status: 'completed',
        summary: `Coordinator requests builder retry ${state.retryCount + 1}/${state.maxRetries}.`,
        details: review.requiredFixes,
        replaceBlockers: review.requiredFixes,
        decision: 'retry_builder',
        markSubtasks: [
          { id: 'build', status: 'pending', note: 'Coordinator requested a revised build.' },
          { id: 'review', status: 'pending', note: 'Awaiting revised build.' },
        ],
      };
    }

    return {
      status: 'blocked',
      summary: 'Coordinator escalates after exhausting retries.',
      details: review.requiredFixes,
      replaceBlockers: review.requiredFixes,
      decision: 'escalate',
      runStatus: 'blocked',
      markSubtasks: [{ id: 'review', status: 'blocked', note: 'Retry budget exhausted.' }],
    };
  }
}

function createSubtasks(): RunSubtask[] {
  return [
    {
      id: 'research',
      title: 'Research facts and constraints',
      owner: 'researcher',
      status: 'pending',
      notes: [],
      retryCount: 0,
    },
    {
      id: 'build',
      title: 'Build one bounded implementation proposal',
      owner: 'builder',
      status: 'pending',
      notes: [],
      retryCount: 0,
    },
    {
      id: 'review',
      title: 'Review output for risks and missing edges',
      owner: 'reviewer',
      status: 'pending',
      notes: [],
      retryCount: 0,
    },
    {
      id: 'verify',
      title: 'Verify result before success',
      owner: 'verifier',
      status: 'pending',
      notes: [],
      retryCount: 0,
    },
  ];
}

function detectFocus(task: string): string[] {
  const lower = task.toLowerCase();
  const focus = [
    'Keep the loop bounded: inspect once, patch once, verify once.',
    'Pass checkpoints instead of full raw history between phases.',
  ];

  if (lower.includes('cli')) {
    focus.push('Expose a thin CLI entrypoint for single-task execution.');
  }
  if (lower.includes('json') || lower.includes('state') || lower.includes('memory')) {
    focus.push('Persist shared state to lightweight JSON files.');
  }
  if (lower.includes('checkpoint') || lower.includes('compact')) {
    focus.push('Make checkpoint compaction a first-class artifact.');
  }
  if (lower.includes('review') || lower.includes('verify')) {
    focus.push('Keep reviewer and verifier as mandatory gates.');
  }
  if (lower.includes('readme') || lower.includes('demo')) {
    focus.push('Ship a README and a runnable demo task.');
  }

  return [...new Set(focus)];
}
