# Ruflo-to-Colony global plan

Status: draft plan
Owner: Colony maintainers
Created: 2026-05-03
Scope: self-learning coordination, token-saving context surfaces, and suggestion quality

## Purpose

Colony already has the core pieces that Ruflo-style learning needs:

- deterministic offline compression in `packages/compress` and `docs/compression.md`
- progressive-disclosure MCP guidance in `docs/mcp.md`
- task-level semantic suggestion through `task_suggest_approach`
- weighted task embeddings in `packages/core/src/task-embeddings.ts`
- attention capping in `packages/core/src/attention-budget.ts`
- example foraging in `packages/foraging`

This plan improves those existing primitives using Ruflo ideas without porting
Ruflo as a dependency, without copying Ruflo swarm/runtime code, and without
adding neural learning in the first implementation pass.

The goal is a Colony-native learning loop:

```text
observe task -> compress evidence -> record outcome -> extract reusable pattern
-> rank pattern for similar future work -> inject only tiny useful hints
-> measure whether hint saved time/tokens -> reinforce or suppress
```

## Ruflo ideas worth porting

Local source references:

- `examples/ruflo/ruflo/src/mcp-bridge/index.js`
- `ruflo/v3/@claude-flow/swarm/src/queen-coordinator.ts`
- `ruflo/v3/@claude-flow/swarm/src/workers/worker-dispatch.ts`

Patterns to port:

1. Outcome learning.
   Ruflo records task results with success, duration, quality, domain, and
   agent fields. Colony should record durable `task-outcome` observations when
   plan subtasks, handoffs, or branch finish flows complete.

2. Pattern memory.
   Ruflo exposes pattern store/search/synthesis surfaces. Colony already has
   observations, embeddings, and task similarity; add a typed `learned-pattern`
   layer on top of those instead of a parallel memory database.

3. Trigger routing.
   Ruflo classifies prompts into triggers like `ultralearn`, `optimize`,
   `consolidate`, and `predict`. Colony should use a smaller advisory trigger
   classifier for startup hints and ready-work routing, not for autonomous
   execution.

4. Context injection discipline.
   Ruflo injects only completed worker summaries. Colony should inject only
   learned hints that pass confidence, freshness, and token-budget gates.

5. Memory consolidation.
   Ruflo has a memory maintenance concept. Colony should add deterministic
   observation consolidation and stale-pattern suppression before adding any
   neural or model-generated learning.

## Non-goals

- Do not add `ruflo` or `@claude-flow/*` packages to Colony.
- Do not copy Ruflo worker execution, swarm topology, or browser/security tools.
- Do not add a new database when existing observations and embeddings can carry
  the data.
- Do not make SessionStart longer by default.
- Do not use an LLM on the write path for compression, extraction, or routing.
- Do not inject full past-task bodies into prompts.

## Current Colony baseline to improve

### Compression

Current baseline:

- `packages/compress/src/compress.ts`
- `packages/compress/src/tokenize.ts`
- `packages/compress/src/count.ts`
- `packages/core/src/memory-store.ts`
- `docs/compression.md`

Current strength:

- deterministic compression
- technical-token preservation
- no model call on write path
- privacy redaction before storage

Upgrade target:

- record token receipts for every compressed observation
- store `tokens_before`, `tokens_after`, `saved_tokens`, `saved_ratio`, and
  `compression_intensity` in observation metadata
- add aggregate compression stats to `colony status`, `colony debrief`, and
  health diagnostics
- add fixture-based regression for special token categories that must never be
  damaged: commands, paths, URLs, dates, versions, code fences, branch names,
  PR URLs, and OpenSpec row IDs

### Progressive disclosure

Current baseline:

- `docs/mcp.md`
- `apps/mcp-server/src/tools/search.ts`
- `apps/mcp-server/src/tools/hivemind.ts`
- `apps/mcp-server/src/tools/attention.ts`
- `apps/mcp-server/src/tools/task.ts`
- `packages/hooks/src/handlers/session-start.ts`

Current strength:

- compact first, hydrate later
- `hivemind_context -> attention_inbox -> task_ready_for_agent`
- `get_observations` only after compact IDs are selected

Upgrade target:

- each MCP tool should report an optional `budget` object:
  - `items_available`
  - `items_returned`
  - `collapsed_count`
  - `estimated_tokens_returned`
  - `hydrate_with`
  - `why_collapsed`
- add a strict "no full body by default" invariant to docs and tests
- add budget tests for noisy inboxes, stalled lanes, foraging results, and
  suggestion payloads

### Task suggestions

Current baseline:

- `apps/mcp-server/src/tools/suggest.ts`
- `apps/cli/src/commands/suggest.ts`
- `packages/core/src/suggestion-payload.ts`
- `packages/core/src/task-embeddings.ts`
- `packages/hooks/src/handlers/session-start.ts`

Current strength:

- semantic similar-task lookup
- first-file prediction
- patterns-to-watch from prior failure events
- median elapsed and handoff hints

Upgrade target:

- add `successful_patterns`
- add `failure_patterns`
- add `token_budget_hints`
- add `recommended_first_actions`
- add `do_not_repeat`
- add confidence and support counts for every hint
- log when a high-similarity suggestion is withheld from SessionStart due to
  budget or confidence gates

### Weighted embeddings

Current baseline:

- `packages/core/src/task-embeddings.ts`
- `packages/storage/src/storage.ts`
- `packages/embedding`

Current strength:

- task centroid from observation embeddings
- kind weights reduce tool-use noise
- minimum embedded observation floor
- stale cache invalidation by observation-count drift

Upgrade target:

- add weights for new kinds:
  - `task-outcome`: high
  - `learned-pattern`: high
  - `token-receipt`: low
  - `suggestion-debrief`: medium
  - `verification-evidence`: high
- use outcome-success metadata to rank completed tasks above abandoned tasks
- include recency decay for suggestions, but never hide old high-confidence
  failure patterns
- keep sparse data honest: no suggestion when corpus or support is weak

### Attention budget

Current baseline:

- `packages/core/src/attention-budget.ts`
- `packages/hooks/src/handlers/session-start.ts`
- `packages/hooks/test/attention-budget.test.ts`

Current strength:

- blocks and needs-reply items are prioritized
- noisy items are collapsed
- SessionStart shows compact attention summary

Upgrade target:

- make budget policy configurable by surface:
  - SessionStart max 3 prominent items
  - HUD max 5 compact items
  - CLI status max 10 compact items
  - MCP full inbox explicit limit only
- add item-level reason:
  - `selected_due_to=blocking`
  - `selected_due_to=expires_soon`
  - `collapsed_due_to=budget`
  - `collapsed_due_to=weak_expired`
- add token estimate to attention output
- add "stale ownership release advice" without surfacing long expired bodies

## Proposed data model

Use observations first. Add schema only if query speed or integrity requires it
after the first implementation slices.

### New observation kinds

`task-outcome`

Content:

```text
task outcome: success=<true|false> duration=<ms> quality=<0..1> verification=<summary>
```

Metadata:

```json
{
  "task_id": 123,
  "repo_root": "/abs/repo",
  "branch": "agent/codex/example",
  "agent": "codex",
  "success": true,
  "duration_ms": 123456,
  "quality_score": 0.9,
  "files_changed": ["packages/core/src/example.ts"],
  "tests": ["pnpm --filter @colony/core test"],
  "pr_url": "https://github.com/recodeee/colony/pull/123",
  "merge_state": "MERGED",
  "handoff_count": 1,
  "blocker_count": 0,
  "token_receipt_ids": [456]
}
```

`learned-pattern`

Content:

```text
when=<task shape>; do=<approach>; avoid=<failure>; proof=<evidence pointer>
```

Metadata:

```json
{
  "pattern_type": "success|failure|token-saving|routing|verification",
  "support_task_ids": [123, 124],
  "support_count": 2,
  "confidence": 0.74,
  "repo_root": "/abs/repo",
  "applies_to_files": ["packages/hooks/src/handlers/session-start.ts"],
  "trigger": "optimize",
  "freshness": "current",
  "last_seen_at": 1777830000000
}
```

`token-receipt`

Content:

```text
token receipt: surface=<surface> before=<n> after=<n> saved=<n> reason=<reason>
```

Metadata:

```json
{
  "surface": "SessionStart|attention_inbox|hivemind_context|task_suggest_approach",
  "tokens_before": 1200,
  "tokens_after": 310,
  "saved_tokens": 890,
  "saved_ratio": 0.742,
  "items_available": 42,
  "items_returned": 3,
  "collapsed_count": 39,
  "policy": "session-start-v1"
}
```

`verification-evidence`

Content:

```text
verification: command=<cmd> status=<pass|fail|blocked> evidence=<short pointer>
```

Metadata:

```json
{
  "command": "pnpm --filter @colony/core test",
  "status": "pass",
  "duration_ms": 12000,
  "scope": "core",
  "task_id": 123
}
```

## Suggested architecture

### Core package

Add:

- `packages/core/src/outcome-learning.ts`
- `packages/core/src/pattern-synthesis.ts`
- `packages/core/src/token-receipts.ts`
- `packages/core/src/trigger-routing.ts`

Responsibilities:

- derive task outcomes from task timeline and explicit completion calls
- extract deterministic learned patterns from existing observations
- build token receipt objects from known before/after strings
- classify prompts into advisory triggers using deterministic regexes
- never call LLMs

### Storage package

Start with no table changes. Use observation metadata and current embedding
backfill.

Add table/index only if needed after MVP:

- `learned_patterns(pattern_id, repo_root, pattern_type, confidence, support_count, last_seen_at)`
- `token_receipts(receipt_id, observation_id, surface, tokens_before, tokens_after, saved_tokens)`

Reason to delay schema:

- current observations already support durable audit
- fewer migrations
- easier rollback
- embedding worker already indexes observations

### MCP server

Extend:

- `task_suggest_approach`
- `hivemind_context`
- `attention_inbox`
- `get_observations`
- foraging tools

New optional tool after MVP:

`task_learned_patterns`

Purpose:

```text
Return high-confidence learned patterns for query/repo/task without full task bodies.
```

Payload:

```json
{
  "patterns": [
    {
      "kind": "token-saving",
      "confidence": 0.82,
      "summary": "Use compact startup profile before hydrating task bodies",
      "support_count": 5,
      "hydrate_with": "get_observations",
      "observation_ids": [1234]
    }
  ],
  "budget": {
    "items_available": 20,
    "items_returned": 3,
    "estimated_tokens_returned": 180
  }
}
```

### CLI

Add or extend:

- `colony suggest`
- `colony debrief`
- `colony status`
- `colony health`

New commands:

```bash
colony learn outcomes --repo-root <path> --since <duration>
colony learn patterns --repo-root <path> --limit <n>
colony learn tokens --repo-root <path> --surface SessionStart
```

All commands should support `--json`.

### Hooks

Extend:

- `packages/hooks/src/handlers/session-start.ts`
- `packages/hooks/src/handlers/session-end.ts`
- relevant task/plan completion paths

Rules:

- SessionStart may inject tiny hints only.
- SessionEnd may roll up summaries and write `task-outcome` when enough signal
  exists.
- Completion MCP tools should write explicit `task-outcome` because they have
  stronger proof than SessionEnd.
- Hook failures must never block the user workflow.

## Implementation phases

### Phase 0: Baseline and contract

Goal:

Measure current behavior before changing suggestion or prompt surfaces.

Files likely touched:

- `docs/compression.md`
- `docs/mcp.md`
- `packages/hooks/test/session-start.test.ts`
- `packages/hooks/test/attention-budget.test.ts`
- `packages/core/test/*suggest*`

Tasks:

- document current token-saving invariants
- add test fixture proving startup suggestion stays compact
- add budget fixture for attention inbox with many stale lanes
- add benchmark command or test helper that counts tokens in generated
  SessionStart sections

Acceptance:

- existing behavior is locked by tests
- no production behavior changes yet
- plan references exact proof commands

### Phase 1: Token receipts

Goal:

Make token savings measurable instead of anecdotal.

Files likely touched:

- `packages/core/src/token-receipts.ts`
- `packages/core/src/memory-store.ts`
- `packages/core/src/index.ts`
- `packages/hooks/src/handlers/session-start.ts`
- `apps/cli/src/commands/debrief.ts`
- `apps/cli/src/commands/status.ts`

Tasks:

- create token receipt builder
- record compression receipts on observation write
- record surface receipts for SessionStart sections
- summarize receipts in `colony debrief`
- show aggregate compression stats in `colony status`

Acceptance:

- receipts are deterministic
- no secret or private text stored in receipt metadata
- status/debrief show before/after counts
- tests prove receipts do not expand prompt output

### Phase 2: Outcome recording

Goal:

Record what worked and what failed in a queryable, compact form.

Files likely touched:

- `packages/core/src/outcome-learning.ts`
- `apps/mcp-server/src/tools/plan.ts`
- `apps/mcp-server/src/tools/task.ts`
- `apps/mcp-server/src/tools/relay.ts`
- `packages/hooks/src/handlers/session-end.ts`
- `packages/core/src/task-thread.ts`

Tasks:

- define `TaskOutcomeInput`
- write `task-outcome` observations when `task_plan_complete_subtask` succeeds
- write outcome on handoff/relay with `success=false` or `status=blocked`
- infer outcome at SessionEnd only when current task binding is unambiguous
- record tests, PR, merge state, dirty files, and cleanup state when available

Acceptance:

- completion writes one outcome, not duplicates
- blocked or quota handoffs record useful failure outcomes
- no outcome claims success without verification evidence

### Phase 3: Learned pattern synthesis

Goal:

Turn task history into durable advice without using an LLM.

Files likely touched:

- `packages/core/src/pattern-synthesis.ts`
- `packages/core/src/suggestion-payload.ts`
- `packages/core/src/task-embeddings.ts`
- `packages/core/test/*suggest*`

Tasks:

- synthesize success patterns from completed tasks
- synthesize failure patterns from blockers, cancelled handoffs, expired
  handoffs, stranded rescue, plan archive failures, and failed verification
- aggregate support counts across similar tasks
- assign confidence with conservative thresholds
- add `learned-pattern` observation writing from CLI and maybe MCP

Acceptance:

- sparse corpus returns honest insufficient-data
- high-confidence failure patterns appear even when old
- pattern summaries are compact and evidence-linked
- no full task body is injected into SessionStart

### Phase 4: Suggestion payload upgrade

Goal:

Make `task_suggest_approach` the main self-learning surface.

Files likely touched:

- `packages/core/src/suggestion-payload.ts`
- `apps/mcp-server/src/tools/suggest.ts`
- `apps/cli/src/commands/suggest.ts`
- `packages/hooks/src/handlers/session-start.ts`

Tasks:

- add `successful_patterns`
- add `failure_patterns`
- add `token_budget_hints`
- add `recommended_first_actions`
- add `do_not_repeat`
- include support count, confidence, and observation IDs
- render compact CLI output
- inject only top 1-2 hints into SessionStart when confidence and budget pass

Acceptance:

- payload remains compact by default
- CLI has full JSON for deeper review
- SessionStart hint has deterministic max line count
- tests cover withheld hints and logged debriefs

### Phase 5: Adaptive attention budget

Goal:

Improve the existing attention cap with reasons, surfaces, and token estimates.

Files likely touched:

- `packages/core/src/attention-budget.ts`
- `packages/hooks/src/handlers/session-start.ts`
- `apps/mcp-server/src/tools/attention.ts`
- `apps/mcp-server/src/tools/hivemind.ts`
- `packages/hooks/test/attention-budget.test.ts`

Tasks:

- add per-surface budget policy
- add selected/collapsed reasons
- add estimated tokens returned
- collapse weak expired claims by default
- keep blocking items always prominent

Acceptance:

- no blocking item is hidden
- expired weak claims do not dominate startup
- output explains why items were selected or collapsed
- tests prove deterministic ordering

### Phase 6: Advisory trigger routing

Goal:

Use Ruflo-style trigger patterns to choose hints and tools, not to execute
autonomous work.

Files likely touched:

- `packages/core/src/trigger-routing.ts`
- `packages/hooks/src/handlers/session-start.ts`
- `apps/mcp-server/src/tools/ready-queue.ts`
- `apps/cli/src/commands/plans.ts`

Initial triggers:

- `learn`: user asks to understand, investigate, map, explain, or port
- `optimize`: user asks to save tokens, reduce context, speed up, or shrink
- `consolidate`: user asks cleanup, stale claims, memory cleanup, dedupe
- `predict`: user asks status, risk, likely next work, or what will happen
- `verify`: user asks proof, checks, finish, or merge state

Tasks:

- classify prompt or branch/task text
- feed trigger into suggestion query
- add trigger-specific token hints
- use trigger only as advisory metadata in ready-work ranking

Acceptance:

- trigger routing never launches workers by itself
- user-visible output stays unchanged unless a high-confidence hint exists
- tests cover typo-heavy prompts

### Phase 7: Foraging and Ruflo source cleanup

Goal:

Make example imports useful without turning Colony into a file dump.

Files likely touched:

- `packages/foraging/src/indexer.ts`
- `packages/foraging/src/integration-plan.ts`
- `apps/cli/src/commands/foraging.ts`
- `apps/mcp-server/src/tools/foraging.ts`

Tasks:

- improve foraging query coverage for large nested examples like Ruflo
- index README, manifest, selected entrypoints, and filetree only
- add source tags like `concept=outcome-learning` or `concept=token-budget`
- avoid indexing generated build outputs and massive vendored trees
- add plan output that says "port concept" vs "copy file"

Acceptance:

- `examples_query` finds Ruflo learning/token patterns
- integration plan no longer suggests broad dependency import
- filetree output remains compact

### Phase 8: Health and rollout metrics

Goal:

Make learning adoption visible and falsifiable.

Files likely touched:

- `apps/cli/src/commands/health.ts`
- `apps/cli/src/commands/debrief.ts`
- `apps/cli/src/commands/status.ts`
- `docs/mcp.md`

Metrics:

- suggestion shown count
- suggestion withheld count
- suggestion accepted proxy count
- repeated failure suppressed count
- token receipts before/after
- average SessionStart token estimate
- task completion time by similar-task cluster
- stale/expired attention collapse rate

Acceptance:

- health can say whether learning is active
- debrief can show token savings trend
- status can show embedding/pattern backfill state
- no metric depends on model-generated text

## Global task breakdown

Use these as future OpenSpec or Colony plan slices.

### Slice A: Lock current behavior

Type: test/doc
Risk: low
Files:

- `docs/compression.md`
- `docs/mcp.md`
- `packages/hooks/test/session-start.test.ts`
- `packages/hooks/test/attention-budget.test.ts`

Done when:

- current compactness and progressive-disclosure behavior have tests
- docs define the exact budget invariants

### Slice B: Token receipts

Type: core/cli/test
Risk: moderate
Files:

- `packages/core/src/token-receipts.ts`
- `packages/core/src/memory-store.ts`
- `apps/cli/src/commands/debrief.ts`
- `apps/cli/src/commands/status.ts`

Done when:

- every new observation can report deterministic compression savings
- CLI summarizes savings without reading full bodies

### Slice C: Outcome observations

Type: core/mcp/test
Risk: moderate
Files:

- `packages/core/src/outcome-learning.ts`
- `apps/mcp-server/src/tools/plan.ts`
- `apps/mcp-server/src/tools/task.ts`
- `apps/mcp-server/src/tools/relay.ts`

Done when:

- complete/block/handoff paths record compact outcomes
- no false success outcome is produced without verification evidence

### Slice D: Pattern synthesis

Type: core/test
Risk: moderate
Files:

- `packages/core/src/pattern-synthesis.ts`
- `packages/core/src/suggestion-payload.ts`
- `packages/core/src/task-embeddings.ts`

Done when:

- successful and failed prior tasks become confidence-ranked hints
- sparse data produces `insufficient_data_reason`

### Slice E: Suggestion surface

Type: mcp/cli/hooks/test
Risk: moderate
Files:

- `apps/mcp-server/src/tools/suggest.ts`
- `apps/cli/src/commands/suggest.ts`
- `packages/hooks/src/handlers/session-start.ts`

Done when:

- `task_suggest_approach` returns learned patterns and token hints
- SessionStart injects only tiny high-confidence hints

### Slice F: Adaptive attention budget

Type: core/mcp/hooks/test
Risk: moderate
Files:

- `packages/core/src/attention-budget.ts`
- `apps/mcp-server/src/tools/attention.ts`
- `apps/mcp-server/src/tools/hivemind.ts`
- `packages/hooks/src/handlers/session-start.ts`

Done when:

- attention output includes selected/collapsed reasons and token estimates
- weak expired noise stays collapsed

### Slice G: Trigger routing

Type: core/hooks/ready-queue/test
Risk: low to moderate
Files:

- `packages/core/src/trigger-routing.ts`
- `packages/hooks/src/handlers/session-start.ts`
- `apps/mcp-server/src/tools/ready-queue.ts`

Done when:

- typo-heavy prompts map to advisory triggers
- triggers improve suggestion query and ready-work hints without auto-execution

### Slice H: Foraging upgrade

Type: foraging/mcp/cli/test
Risk: low
Files:

- `packages/foraging/src/indexer.ts`
- `packages/foraging/src/integration-plan.ts`
- `apps/mcp-server/src/tools/foraging.ts`
- `apps/cli/src/commands/foraging.ts`

Done when:

- Ruflo learning/token concepts are discoverable through `examples_query`
- integration plan says concept-port, not dependency-copy

## Acceptance criteria for the full program

- Colony records task outcomes for completed and blocked work.
- Colony records token receipts for compressed observations and startup
  surfaces.
- `task_suggest_approach` returns success patterns, failure patterns, token
  hints, first actions, and do-not-repeat guidance.
- SessionStart stays compact and deterministic.
- Similar tasks improve future startup hints without loading full task bodies.
- Attention output explains why items were prominent or collapsed.
- Ruflo examples remain examples only; no runtime dependency is added.
- All new learning surfaces have focused tests.
- Health/debrief can prove whether token usage improved.

## Verification plan

Focused tests:

```bash
pnpm --filter @colony/compress test
pnpm --filter @colony/core test
pnpm --filter @colony/hooks test -- session-start
pnpm --filter @colony/hooks test -- attention-budget
pnpm --filter @colony/mcp-server test
pnpm --filter @colony/foraging test
```

Static checks:

```bash
pnpm typecheck
pnpm lint
openspec validate --specs
```

Manual proof:

```bash
colony suggest "reduce startup token usage with learned patterns" --repo-root <repo>
colony debrief --repo-root <repo> --since 7d --json
colony status
```

Required evidence before closing the full program:

- before/after SessionStart token estimate
- before/after `attention_inbox` payload size on noisy task #1
- sample `task-outcome` observation
- sample `learned-pattern` observation
- sample `task_suggest_approach` payload
- proof that Ruflo is not added to `package.json`

## Risks and mitigations

Risk: learned hints become wrong or stale.

Mitigation:

- use confidence thresholds
- require support counts
- include evidence observation IDs
- decay success hints over time
- keep failure hints longer

Risk: startup gets longer.

Mitigation:

- hard cap SessionStart hint lines
- log debrief instead of injecting when confidence is low
- add token receipt checks in tests

Risk: outcome recording claims false success.

Mitigation:

- success requires explicit completion path or verified PR/merge evidence
- blocked, quota, and handoff paths record non-success outcomes
- include `Not-tested`/verification gaps in outcome metadata

Risk: foraging indexes too much Ruflo content.

Mitigation:

- cap files and bytes
- index concept entrypoints only
- classify as concept-port
- keep full bodies behind `get_observations`

Risk: new metadata becomes inconsistent.

Mitigation:

- central builders in `packages/core`
- schema validation in tests
- avoid parallel ad hoc metadata shapes in MCP and CLI

## Open questions

- Should `task-outcome` be written by branch finish hooks, MCP completion tools,
  or both?
- Should learned-pattern extraction run synchronously at completion or in the
  background worker?
- What confidence threshold is high enough for SessionStart injection?
- Should token receipts be first-class storage rows after the MVP?
- Which CLI command should own manual backfill: `colony learn` or `colony debrief --learn`?

## Recommended first implementation PR

Start with Slice A plus the smallest part of Slice B.

Why:

- locks current behavior first
- creates measurement before changing prompts
- low user-visible risk
- gives every later slice a proof surface

PR scope:

- add `packages/core/src/token-receipts.ts`
- add tests for token receipt builder
- add SessionStart token receipt test helper
- update `docs/compression.md` and `docs/mcp.md` with budget invariants
- do not alter `task_suggest_approach` yet

Exit criteria:

- tests pass
- docs explain budget invariants
- receipt builder proves before/after savings on fixtures
- no startup output growth
