# Hivemind Demo

Minimal local multi-agent MVP for bounded software-task execution.

This package simulates a small hivemind with five deterministic agents:

- `Coordinator`
- `Researcher`
- `Builder`
- `Reviewer`
- `Verifier`

Each run writes shared JSON state after every step, compacts progress into checkpoints, and requires verifier approval before returning success.

## File Tree

```text
apps/hivemind-demo/
  data/
    runs/
  src/
    agents/
      coordinator.ts
      researcher.ts
      builder.ts
      reviewer.ts
      verifier.ts
    core/
      orchestrator.ts
      state.ts
      checkpoint.ts
      types.ts
    cli/
      index.ts
    utils/
      logger.ts
      ids.ts
    index.ts
  test/
    orchestrator.test.ts
  package.json
  tsconfig.json
  README.md
```

## What It Does

- Accepts one task from the CLI
- Creates a bounded plan
- Runs research, build, review, and verification phases
- Writes `state.json` after every phase
- Creates checkpoint summaries every few steps
- Stops on verifier approval, retry exhaustion, or max-turn failure

Persisted run output lives under `data/runs/<run-id>/`:

- `state.json`
- `checkpoints/*.json`
- `final-output.json` when verification succeeds

## Run It

From the package directory:

```sh
pnpm install
pnpm run demo
pnpm build
node dist/cli/index.js "Create a local TypeScript CLI that plans, reviews, and verifies a task with checkpoint summaries."
```

Or point output somewhere disposable:

```sh
node dist/cli/index.js --data-dir /tmp/hivemind-runs --demo
```

## Example Usage

```sh
node dist/cli/index.js "Build a local TypeScript CLI with JSON state, checkpoints, README, and verifier approval."
```

Example output:

```text
[hivemind] coordinator/plan: Coordinator planned a 4-step hivemind loop.
[hivemind] researcher/research: Researcher captured 5 constraints and 4 focus areas.
[hivemind] builder/build: Builder produced attempt 1 with 16 files in scope.
[hivemind] reviewer/review: Reviewer approved builder output.
[hivemind] coordinator/decide: Coordinator sends approved build to verifier.
[hivemind] verifier/verify: Verifier approved final output.
Run: run-2026-04-23T18-00-00-000Z
Status: completed
Run dir: /.../apps/hivemind-demo/data/runs/run-2026-04-23T18-00-00-000Z
Checkpoints: 3
```

## Demo Flow

1. Coordinator creates a bounded plan and subtasks.
2. Researcher extracts constraints, assumptions, and focus areas from the task text.
3. Builder turns that research into a file tree, implementation plan, test plan, and checkpoint policy.
4. Reviewer checks for missing required files, tests, and compaction rules.
5. Coordinator decides whether to retry the builder or continue.
6. Verifier approves only when plan, artifacts, and checkpoints exist.

## Limitations

- Agent behavior is deterministic. No real LLM reasoning is exercised.
- Execution is sequential. There is no parallel worker scheduling yet.
- Tool use is not wired in. The system only simulates agent decisions.
- Checkpoints are simple summaries, not semantic compression or retrieval.

## Extending With Real Model / Tool Calls

The extension points already exist in `src/core/types.ts`:

- `ModelProvider`
- `ToolRunner`

To replace the deterministic agents later:

1. Implement a `ModelProvider` that turns agent prompts + state into model output.
2. Implement a `ToolRunner` for file, web, or code tools.
3. Swap the current agent bodies to call those interfaces instead of heuristic rules.
4. Keep the checkpoint contract unchanged so coordination cost stays bounded.

That keeps the MVP shape stable while the inner reasoning surface becomes real.
