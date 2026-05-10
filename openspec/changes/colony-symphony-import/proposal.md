# Colony Symphony Import

## Why

Colony has a durable Symphony context in `openspec/specs/colony-symphony/context.md`,
but Waves 2-7 need one umbrella change that turns the upstream checklist into
claimable Colony work. The change records the adoption phases, the tracker
decision, and the phase-gated verification ledger before implementation starts.

## What Changes

- Open a seven-wave adoption ledger for Symphony-to-Colony work.
- Map Symphony Section 18.1 REQUIRED conformance items into Colony-native
  requirements by wave.
- Map Symphony Section 18.2 RECOMMENDED extensions into optional follow-up
  requirements without making them blockers for core conformance.
- Record `Colony-as-tracker` as the tracker decision for this port.

## Scope

1. Wave 1: reference import, domain mapping, and umbrella ledger.
2. Wave 2: workflow path, `WORKFLOW.md` loading, front matter, config defaults,
   env indirection, and reload.
3. Wave 3: Colony tracker intake, candidate refresh, terminal refresh, and typed
   issue/task normalization.
4. Wave 4: workspace manager, lifecycle hooks, Codex app-server launch, prompt
   rendering, retry queue, and retry backoff.
5. Wave 5: single-authority orchestration, polling, reconciliation, status-flip
   handling, and terminal cleanup.
6. Wave 6: structured logs, runtime snapshots, monitoring surface, and optional
   HTTP control surface.
7. Wave 7: safety invariants, production validation, extension boundaries, and
   archive readiness.

## Non-Goals

- Do not vendor, translate, or depend on upstream Symphony Elixir code under any
  repo path.
- Do not make Linear the tracker for Colony adoption. Linear-as-tracker is N/A;
  Colony is the tracker and coordination substrate.
- Do not start package, app, or runtime implementation work in this change.
- Do not mark checklist rows complete without command evidence or merged PR
  evidence.

## Risks

- Wave 5 can accidentally flip task or run status if reconciliation treats
  observed Colony state as write intent. Wave 5 must prove read/stop/cleanup
  behavior before any status-transition automation is accepted.
- Symphony terminology can leak Linear assumptions into Colony. The spec and
  design docs must keep tracker behavior Colony-native.
- Optional extensions can blur conformance. Section 18.2 items stay
  RECOMMENDED unless a later change explicitly promotes them.

## Impact

Agents 200-229 get one OpenSpec surface for claiming, sequencing, and verifying
the Symphony adoption phases without starting code from a static prompt pack.
