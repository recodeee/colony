import { type QueenOrderedPlanInput, orderedPlanFromWaves } from './decompose.js';

export const colonyAdoptionFixesPlanInput: QueenOrderedPlanInput = {
  slug: 'colony-adoption-fixes',
  title: 'Colony adoption fixes',
  problem:
    'Queen should publish the current Colony adoption fixes as claimable ordered waves so agents pull work through task_ready_for_agent and task_plan_claim_subtask instead of direct runtime assignment.',
  acceptance_criteria: [
    'Wave 1 exposes the Codex/OMX claim-before-edit bridge, active task binding for auto-claim, and the hivemind_context to attention_inbox funnel as immediately claimable work.',
    'Wave 2 unlocks task_ready_for_agent to task_plan_claim_subtask conversion, task_message adoption, and proposal/foraging adoption after Wave 1 completes.',
    'Wave 3 unlocks docs, tests, and health finalization after Wave 2 completes.',
    'Queen publishes structure only; agents pull and claim subtasks themselves.',
  ],
  waves: [
    {
      id: 'wave-1',
      title: 'Claim and inbox funnel',
      subtasks: [
        {
          title: 'Codex/OMX claim-before-edit bridge',
          description:
            'Bridge Codex and OMX edit telemetry into the claim-before-edit path so write-like tool calls can be covered before mutation.',
          file_scope: [
            'packages/hooks/src/handlers/pre-tool-use.ts',
            'packages/hooks/test/session-start-conflicts.test.ts',
          ],
          capability_hint: 'infra_work',
        },
        {
          title: 'Active task binding for auto-claim',
          description:
            'Resolve the correct active task before auto-claiming touched files for Codex and OMX sessions.',
          file_scope: [
            'packages/hooks/src/auto-claim.ts',
            'packages/hooks/test/auto-claim.test.ts',
          ],
          capability_hint: 'infra_work',
        },
        {
          title: 'Strengthen hivemind_context to attention_inbox funnel',
          description:
            'Keep hivemind_context routing agents through attention_inbox before task_ready_for_agent work selection.',
          file_scope: [
            'apps/mcp-server/src/tools/shared.ts',
            'apps/mcp-server/test/server.test.ts',
          ],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      id: 'wave-2',
      title: 'Adoption conversions',
      subtasks: [
        {
          title: 'Convert task_ready_for_agent results into task_plan_claim_subtask',
          description:
            'Turn ready queue output into exact task_plan_claim_subtask calls so agents claim published plan work instead of stopping at discovery.',
          file_scope: [
            'apps/mcp-server/src/tools/ready-queue.ts',
            'apps/mcp-server/test/ready-queue.test.ts',
          ],
          capability_hint: 'api_work',
        },
        {
          title: 'Adopt task_message for directed coordination',
          description:
            'Move directed agent coordination from generic notes into task_message so inbox adoption improves and replies stay threaded.',
          file_scope: [
            'apps/mcp-server/src/tools/message.ts',
            'apps/mcp-server/test/messages.test.ts',
          ],
          capability_hint: 'api_work',
        },
        {
          title: 'Adopt proposal and foraging flows',
          description:
            'Route future-work discovery through proposal and foraging tools so promoted work becomes pull-based plan structure.',
          file_scope: [
            'apps/mcp-server/src/tools/proposal.ts',
            'apps/mcp-server/src/tools/foraging.ts',
            'apps/mcp-server/test/foraging.test.ts',
          ],
          capability_hint: 'api_work',
        },
      ],
    },
    {
      id: 'wave-3',
      title: 'Docs and tests finalization',
      subtasks: [
        {
          title: 'Finalize docs, tests, and health',
          description:
            'Document and test the full Colony adoption loop, including active Queen plan health and ready subtask visibility.',
          file_scope: [
            'docs/QUEEN.md',
            'apps/cli/src/commands/health.ts',
            'apps/cli/test/queen-health.test.ts',
            'apps/mcp-server/test/coordination-loop.test.ts',
            'packages/queen/test/decompose.test.ts',
          ],
          capability_hint: 'test_work',
        },
      ],
    },
  ],
};

export const colonyAdoptionFixesPlan = orderedPlanFromWaves(colonyAdoptionFixesPlanInput);
