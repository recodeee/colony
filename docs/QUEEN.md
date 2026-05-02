# Queen Workflow

## what

Queen is the Colony plan publisher. It turns a clear goal into a published
`task_plan` so other agents can discover, claim, work, and complete independent
sub-tasks through the normal Colony substrate.

Queen is not an orchestrator. It does not start agents, assign agents, watch
running shells, or decide who should do the work. It only publishes
claimable work with enough structure for the rest of Colony to route it.

Queen follows the repository's biological coordination contract:
[`openspec/specs/biological-coordination/spec.md`](../openspec/specs/biological-coordination/spec.md).
That contract is the durable source for the ant model: local stigmergic traces,
pheromone reinforcement, evaporation, response thresholds, pull-based work, and
Queen as plan publisher only.

## biological model in practice

In Colony, "Queen" means the plan-publishing role, not a commander. Queen
creates a useful trail: a bounded `task_plan` with file scopes, capability
hints, dependencies, and optional ordered waves. Workers still choose work by
reading local context and pulling an available sub-task.

Use the model this way:

- Queen publishes; workers pull with `task_ready_for_agent`.
- Ordered waves are dependency edges, not runtime supervision.
- Handoffs, messages, wakes, and proposal reinforcement recruit agents without
  assigning them by force.
- Stale claims and stalled subtasks must evaporate through sweep, rescue, or
  archive instead of staying live forever.
- Before editing a Queen-published subtask, read local traces first:
  `hivemind_context`, `attention_inbox`, `task_ready_for_agent`, then claim the
  subtask or files.

Conceptually queen has two steps:

1. `planGoal`: derive a bounded, claimable plan from a goal.
2. `publishPlan`: publish that plan into the existing `task_plan` substrate.

The substrate is the same one exposed by `task_plan_publish`,
`task_ready_for_agent`, `task_plan_claim_subtask`, and
`task_plan_complete_subtask`. Queen is a front door for publishing into that
system, not a replacement for it.

Queen does not make LLM decisions. Its split is heuristic: task count, file
scope, capability hints, dependency order, acceptance criteria, and
scope-overlap rules. If the goal needs LLM-based decomposition, an agent should
do that reasoning first, then call `queen_plan_goal` with the decomposed Goal.

## when

Use queen when the goal is too large for one direct edit but small enough to
describe as claimable sub-tasks.

Good fits:

- A multi-step goal with at least two independently claimable pieces.
- Work that can be split by file scope, capability, or dependency order.
- Parallel lanes where agents can pull work with `task_ready_for_agent`.
- A migration or release lane where `depends_on` should gate downstream work.
- A plan where `auto_archive` can close the parent change after all sub-tasks
  complete, once that behavior is trusted for the lane.

Do not use queen for a trivial single-file edit, a typo, a version bump, or
anything one agent can finish and verify directly in one pass. Use a normal
task thread or direct branch workflow for those.

Queen also is not the right first step when the goal is still ambiguous. In
that case, a lead agent should clarify the goal, draft acceptance criteria, and
only publish once the sub-task boundaries are concrete.

## how

Queen publishes work into the existing Colony flow:

```text
Goal
  -> planGoal
  -> publishPlan
  -> colony task_plan substrate
  -> agents pull with task_ready_for_agent
  -> task_plan_claim_subtask
  -> work
  -> task_plan_complete_subtask
  -> auto-archive
```

CLI workflow:

1. Start with a concrete Goal: title, problem, acceptance criteria, candidate
   file scopes, and any required ordering.
2. Keep trivial work out of queen. If the plan has only one sub-task, use a
   normal task thread or direct branch instead.
3. From a lead-agent CLI session, ask the agent to publish the Goal through the
   Colony MCP tool `queen_plan_goal`. The CLI session owns decomposition if LLM
   reasoning is needed; queen only receives the decomposed Goal.
4. After publication, do not manually assign agents. Agents call
   `task_ready_for_agent`, claim a ready sub-task, complete it, and let
   downstream work unlock through `depends_on`.

MCP workflow:

1. Call `queen_plan_goal` with `repo_root`, `session_id`, `goal_title`,
   `problem`, `acceptance_criteria`, and optional `affected_files`,
   `ordering_hint`, `waves`, `finalizer`, or `dry_run`.
2. Queen validates the heuristic split and publishes through `publishPlan`.
   The underlying write lands in `task_plan_publish`.
3. Agents call `task_ready_for_agent` to see unblocked work ranked by fit.
4. An agent claims with `task_plan_claim_subtask`; the claim joins the sub-task
   thread and activates file claims for that sub-task scope.
5. The agent finishes with `task_plan_complete_subtask`. When the final
   sub-task completes and `auto_archive` is enabled, the parent plan archives
   automatically unless conflicts block it.

## ordered waves

Queen can describe an ordered plan as waves without creating a scheduler. A
wave is an authoring model for a set of sub-tasks that may run in parallel. The
published contract is still the existing flat `task_plan.subtasks` list, and
agents still pull claimable work through `task_ready_for_agent` and
`task_plan_claim_subtask`.

The model:

```ts
interface QueenExecutionStrategy {
  mode: 'flat_subtasks' | 'ordered_waves';
  claim_model: 'agent_pull';
  scheduler: 'none';
  wave_dependency: 'none' | 'previous_wave';
}

interface QueenPlanWave {
  id: string;
  title: string;
  description?: string;
  subtask_indexes: number[];
}

interface QueenOrderedPlan extends QueenPlan {
  execution_strategy: QueenExecutionStrategy;
  waves: QueenPlanWave[];
}
```

Mapping to `task_plan`:

- Wave 1 sub-tasks publish with empty `depends_on` unless the author adds an
  explicit earlier dependency.
- Each later wave publishes as normal `task_plan` sub-tasks whose `depends_on`
  points at the previous wave's sub-task indexes.
- Because `task_plan_list.next_available` only exposes sub-tasks whose direct
  dependencies are completed, wave 2 stays blocked until wave 1 completes, and
  wave 3 stays blocked until wave 2 completes.
- Same-wave dependencies should be avoided. If one sub-task must wait for
  another, split them into separate waves.
- Extra `depends_on` edges are still valid when a specific sub-task must wait
  for an earlier-wave sub-task. The wave model does not replace existing
  dependency semantics.

Example ordered plan shape for the current adoption fixes:

```json
{
  "execution_strategy": {
    "mode": "ordered_waves",
    "claim_model": "agent_pull",
    "scheduler": "none",
    "wave_dependency": "previous_wave"
  },
  "waves": [
    {
      "id": "wave-1",
      "title": "Coordination adoption funnel",
      "subtask_indexes": [0, 1, 2, 3]
    },
    {
      "id": "wave-2",
      "title": "Runtime health adoption",
      "subtask_indexes": [4, 5, 6]
    },
    {
      "id": "wave-3",
      "title": "Integration docs and tests",
      "subtask_indexes": [7]
    }
  ],
  "subtasks": [
    { "title": "Tighten hivemind_context funnel", "depends_on": [] },
    { "title": "Add task_list ready-work nudge", "depends_on": [] },
    { "title": "Add claim-before-edit preflight", "depends_on": [] },
    { "title": "Increase task_note_working adoption", "depends_on": [] },
    { "title": "Expose OMX bridge status", "depends_on": [0, 1, 2, 3] },
    { "title": "Add stale claim sweep", "depends_on": [0, 1, 2, 3] },
    { "title": "Add health telemetry", "depends_on": [0, 1, 2, 3] },
    { "title": "Add integration docs/tests", "depends_on": [4, 5, 6] }
  ]
}
```

The titles here are plan labels, not runtime assignments or commands. Workers
still choose work by reading `task_ready_for_agent` and claiming with
`task_plan_claim_subtask`. Queen publishes the flat sub-task structure, so
existing `task_plan_publish`, `task_plan_validate`, claim, completion, and
dependency-unlock behavior remain the only execution mechanism.

Example: add Stripe webhook with four sub-tasks.

```json
{
  "repo_root": "/repo",
  "slug": "add-stripe-webhook",
  "title": "Add Stripe webhook",
  "problem": "Billing events are not recorded when Stripe sends webhooks.",
  "acceptance_criteria": [
    "Stripe signatures are verified",
    "Duplicate events are ignored",
    "Webhook behavior is covered by tests"
  ],
  "subtasks": [
    {
      "title": "Add webhook route",
      "description": "Create POST /webhooks/stripe and parse raw bodies.",
      "file_scope": ["apps/api/src/routes/stripe-webhook.ts"],
      "capability_hint": "api_work"
    },
    {
      "title": "Persist Stripe event idempotently",
      "description": "Store event ids and skip duplicates.",
      "file_scope": ["packages/billing/src/stripe-events.ts"],
      "capability_hint": "api_work"
    },
    {
      "title": "Cover webhook verification",
      "description": "Test signatures, duplicates, and rejected payloads.",
      "file_scope": ["apps/api/test/stripe-webhook.test.ts"],
      "depends_on": [0, 1],
      "capability_hint": "test_work"
    },
    {
      "title": "Document Stripe webhook setup",
      "description": "Document endpoint URL, env var, and replay procedure.",
      "file_scope": ["docs/billing.md"],
      "depends_on": [0],
      "capability_hint": "doc_work"
    }
  ]
}
```

Example: migrate from X to Y with a `depends_on` chain.

```json
{
  "repo_root": "/repo",
  "slug": "migrate-x-to-y",
  "title": "Migrate from X to Y",
  "problem": "The system still depends on X, but Y is the supported backend.",
  "acceptance_criteria": [
    "All callers use Y",
    "Compatibility tests pass",
    "X-only code is removed"
  ],
  "subtasks": [
    {
      "title": "Map X behavior to Y",
      "description": "Write compatibility notes and caller impact.",
      "file_scope": ["docs/migrations/x-to-y.md"],
      "capability_hint": "doc_work"
    },
    {
      "title": "Add Y adapter",
      "description": "Implement the Y adapter behind the existing interface.",
      "file_scope": ["packages/core/src/y-adapter.ts"],
      "depends_on": [0],
      "capability_hint": "api_work"
    },
    {
      "title": "Move callers to Y",
      "description": "Switch production call sites from X to the Y adapter.",
      "file_scope": ["apps/api/src/services/resource.ts"],
      "depends_on": [1],
      "capability_hint": "api_work"
    },
    {
      "title": "Remove X path",
      "description": "Delete X-only branches after callers have moved.",
      "file_scope": ["packages/core/src/x-adapter.ts"],
      "depends_on": [2],
      "capability_hint": "api_work"
    },
    {
      "title": "Verify migration parity",
      "description": "Run and extend parity tests for old X fixtures on Y.",
      "file_scope": ["packages/core/test/x-to-y-parity.test.ts"],
      "depends_on": [3],
      "capability_hint": "test_work"
    }
  ],
  "auto_archive": true
}
```

Example: fix flaky tests with tests-only sub-tasks.

```json
{
  "repo_root": "/repo",
  "slug": "fix-flaky-tests",
  "title": "Fix flaky tests",
  "problem": "CI has intermittent failures across independent test suites.",
  "acceptance_criteria": [
    "Targeted flaky suites pass repeatedly",
    "No production behavior changes are made",
    "Each fix records the flake cause"
  ],
  "subtasks": [
    {
      "title": "Stabilize websocket timeout tests",
      "description": "Remove timing assumptions from timeout coverage.",
      "file_scope": ["apps/api/test/websocket-timeout.test.ts"],
      "capability_hint": "test_work"
    },
    {
      "title": "Stabilize worker retry tests",
      "description": "Use deterministic retry control instead of sleeps.",
      "file_scope": ["apps/worker/test/retry.test.ts"],
      "capability_hint": "test_work"
    },
    {
      "title": "Stabilize storage ordering tests",
      "description": "Make storage assertions order-independent.",
      "file_scope": ["packages/storage/test/ordering.test.ts"],
      "capability_hint": "test_work"
    }
  ]
}
```

## cleanup and repair

When health shows zero active Queen plans but a completed plan remains, close
the completed plan before publishing a replacement repair lane:

```bash
colony plan close <slug> --cwd <repo_root>
colony queen adoption-fixes --repo-root <repo_root>
colony task ready --repo-root <repo_root> --agent <agent> --session <session_id> --json
```

The close command refuses incomplete workspaces and records a `plan-archived`
observation on the parent plan task after a clean archive. The adoption-fixes
command is idempotent for an already-active `colony-adoption-fixes` plan, and
the ready command should then return `task_plan_claim_subtask` args for Wave 1.

## what NOT

Queen is not a sub-agent launcher. It never calls Codex, Claude, Cursor, Gemini,
or any other agent. Agents pull from Colony after queen publishes.

Queen is not an assignment engine. It must not assign exact agents as commands;
capability hints and response-threshold rankings are pull signals for agents to
accept, decline, reinforce, or hand off.

Queen is not a shell scheduler. It must not monitor every running shell or infer
global worker state from process activity. Startup context, attention inbox,
ready-work ranking, rescue, sweep, and archive remain the coordination surfaces.
Rescue ranks stale claimed sub-tasks with Queen plan context: a stale early-wave
claim that blocks downstream work surfaces ahead of a stale leaf claim, and
completed downstream sub-tasks do not count as blocked.

Queen must not preserve stale state. Any live signal it emits or surfaces must
expire, decay, sweep, archive, or become an explicit durable record.

Queen is not a running process. There is no queen daemon to monitor, restart, or
keep alive. After publication, the durable state is the `task_plan` substrate.

Queen does not replace hooks. Guardrails, file-claim hooks, session hooks, and
task completion hooks still do their normal jobs. Queen only creates structured
work for those systems to act on.

Queen is not a judgment engine. It does not look at the repo with an LLM and
decide the best architecture. If that reasoning is needed, the lead agent does
it first and passes queen a concrete decomposed Goal.
