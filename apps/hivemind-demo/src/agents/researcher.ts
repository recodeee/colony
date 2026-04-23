import type { Agent, AgentInput, AgentResult, ResearchArtifactContent, RunState } from '../core/types.js';

export class ResearcherAgent implements Agent {
  readonly name = 'Researcher';
  readonly role = 'researcher' as const;

  run(input: AgentInput, _state: RunState): AgentResult {
    const lower = input.task.toLowerCase();
    const facts = unique([
      'Task expects a local MVP rather than remote infrastructure.',
      lower.includes('typescript') || lower.includes('node')
        ? 'Delivery target is a TypeScript / Node.js codebase.'
        : 'Current repo toolchain is TypeScript-first, so the MVP should stay there.',
      lower.includes('cli')
        ? 'A CLI entrypoint is part of the requested behavior.'
        : 'The runnable entrypoint still needs to be explicit.',
    ]);
    const constraints = unique([
      lower.includes('json') || lower.includes('state')
        ? 'Persist shared state in JSON files.'
        : 'Keep persistence lightweight and file-based.',
      lower.includes('mvp')
        ? 'Prefer an MVP over a generalized framework.'
        : 'Keep the first version intentionally small.',
      'Avoid external APIs so the demo runs offline.',
      'Checkpoint summaries should replace transcript replay between phases.',
      'Final output must include result, reasoning summary, open risks, and next steps.',
    ]);
    const assumptions = unique([
      'Deterministic agent logic is enough to prove the orchestration loop.',
      'One run handles one user task from start to finish.',
      'A reviewer plus verifier gate is enough for the first cut.',
    ]);
    const recommendedFocus = unique([
      'Write state after every agent step.',
      'Batch the executor phase instead of drifting through micro-steps.',
      lower.includes('readme') || lower.includes('demo')
        ? 'Document the flow with a runnable demo task.'
        : 'Add README guidance and one demo flow for handoff clarity.',
      lower.includes('checkpoint') || lower.includes('compact')
        ? 'Checkpoint format should be Goal / Done / Current blocker / Next batch.'
        : 'Use compact checkpoints to keep shared context short.',
    ]);

    const content: ResearchArtifactContent = {
      facts,
      constraints,
      assumptions,
      recommendedFocus,
    };

    return {
      status: 'completed',
      summary: `Researcher captured ${constraints.length} constraints and ${recommendedFocus.length} focus areas.`,
      details: [...facts.slice(0, 2), ...recommendedFocus.slice(0, 2)],
      artifact: {
        type: 'research',
        label: 'task-research',
        content,
      },
      markSubtasks: [
        { id: 'research', status: 'completed', note: `Captured ${constraints.length} constraints.` },
        { id: 'build', status: 'in_progress', note: 'Research ready for builder.' },
      ],
      replaceBlockers: [],
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
