import { type QueenOrderedPlanInput, orderedPlanFromWaves } from '../../src/decompose.js';

export const colonyImprovementWaveInput: QueenOrderedPlanInput = {
  slug: 'colony-adoption-fixes',
  title: 'Colony adoption fixes',
  problem:
    'Queen should publish the current adoption fixes as claimable waves so agents pull work through task_ready_for_agent and task_plan_claim_subtask instead of direct runtime assignment.',
  acceptance_criteria: [
    'Wave 1 exposes the coordination funnel and preflight fixes as immediately claimable work.',
    'Wave 2 unlocks bridge status, stale-claim sweep, and health telemetry after Wave 1 completes.',
    'Wave 3 unlocks integration docs and tests after Wave 2 completes.',
    'Queen publishes structure only; agents pull and claim subtasks themselves.',
  ],
  waves: [
    {
      id: 'wave-1',
      title: 'Coordination adoption funnel',
      subtasks: [
        {
          title: 'Tighten hivemind_context funnel',
          description:
            'Keep hivemind_context routing agents toward attention_inbox and task_ready_for_agent before they choose work.',
          file_scope: [
            'apps/mcp-server/src/tools/shared.ts',
            'apps/mcp-server/test/server.test.ts',
          ],
          capability_hint: 'api_work',
        },
        {
          title: 'Add task_list ready-work nudge',
          description:
            'Keep task_list as inventory and nudge task_ready_for_agent before work selection.',
          file_scope: [
            'apps/mcp-server/src/tools/task.ts',
            'apps/mcp-server/test/task-threads.test.ts',
          ],
          capability_hint: 'api_work',
        },
        {
          title: 'Add claim-before-edit preflight',
          description:
            'Warn before write-like tools when the active task has no explicit claim for touched files.',
          file_scope: [
            'packages/hooks/src/handlers/pre-tool-use.ts',
            'packages/hooks/test/session-start-conflicts.test.ts',
          ],
          capability_hint: 'infra_work',
        },
        {
          title: 'Increase task_note_working adoption',
          description:
            'Measure and nudge task_note_working as the Colony-native working-state path.',
          file_scope: ['apps/cli/src/bridge-adoption.ts', 'apps/cli/test/bridge-adoption.test.ts'],
          capability_hint: 'test_work',
        },
      ],
    },
    {
      id: 'wave-2',
      title: 'Runtime health adoption',
      subtasks: [
        {
          title: 'Expose OMX bridge status',
          description: 'Surface compact Colony bridge status for OMX HUD and status consumers.',
          file_scope: [
            'apps/mcp-server/src/tools/bridge.ts',
            'apps/mcp-server/test/bridge-status.test.ts',
          ],
          capability_hint: 'api_work',
        },
        {
          title: 'Add stale claim sweep',
          description:
            'Expose stale claim cleanup signals so old claims stop suppressing ready work.',
          file_scope: ['packages/core/src/claim-age.ts', 'packages/core/test/claim-graph.test.ts'],
          capability_hint: 'api_work',
        },
        {
          title: 'Add health telemetry',
          description:
            'Show loop adoption health, including ready-to-claim and ready-to-claim-to-claim ratios.',
          file_scope: ['apps/cli/src/commands/health.ts', 'apps/cli/test/health.test.ts'],
          capability_hint: 'test_work',
        },
      ],
    },
    {
      id: 'wave-3',
      title: 'Integration docs and tests',
      subtasks: [
        {
          title: 'Add integration docs/tests',
          description:
            'Document and test the full adoption loop after the funnel and health waves land.',
          file_scope: [
            'docs/mcp.md',
            'docs/QUEEN.md',
            'apps/mcp-server/test/coordination-loop.test.ts',
          ],
          capability_hint: 'test_work',
        },
      ],
    },
  ],
};

export const colonyImprovementWaveFixture = orderedPlanFromWaves(colonyImprovementWaveInput);
