// Observation kinds used on spec task-threads. These extend colony's
// existing kind enum ('note' | 'question' | 'answer' | 'decision' |
// 'blocker' | 'claim' | 'handoff' | 'accept' | 'decline' | 'wake' | ...)
// with spec-specific kinds. colony's storage layer stores kind as a free
// string so extension is additive — no schema migration needed.
export const SPEC_OBSERVATION_KINDS = {
  // Writes to the root SPEC.md go through here. One entry per /co:spec
  // invocation; content is a diff patch against the previous root state.
  SPEC_WRITE: 'spec-write',

  // Delta rows authored on an in-flight change. Each §S row (add / modify
  // / remove against a specific §V / §I / §T id) is one observation.
  SPEC_DELTA: 'spec-delta',

  // §B bug entries. Content is a compact failure record; metadata carries
  // the signature hash so /co:build can query by signature.
  SPEC_BUG: 'spec-bug',

  // §V invariant proposals emitted by the backprop gate. These start in
  // a 'draft' state and only promote to the root spec after a /co:spec
  // writer confirms them.
  SPEC_INVARIANT_DRAFT: 'spec-invariant-draft',

  // Final sync event — the archive move completed and the merged root
  // has been written. Used as the sentinel for "everything below this
  // ts is in the archive".
  SPEC_SYNC: 'spec-sync',
} as const;

export type SpecObservationKind =
  (typeof SPEC_OBSERVATION_KINDS)[keyof typeof SPEC_OBSERVATION_KINDS];

// Reserved key in TaskThread.metadata that marks the thread as a spec
// lane. Non-spec tasks never set this, so filters like "list only spec
// changes" are a single WHERE clause against the metadata JSON.
export const SPEC_TASK_METADATA_KEY = 'colonykit_spec_lane' as const;

// Reserved branch prefix for spec changes. Task threads are keyed on
// (repo_root, branch); by convention colonykit owns `spec/*` so it
// cannot collide with a developer's real git branches.
export const SPEC_BRANCH_PREFIX = 'spec/' as const;
