// Public surface for @colony/spec.
//
// colonykit lives here as the spec-driven lane of the colony runtime. The
// core insight: a project "spec" is just a task-thread with a reserved
// shape and a single writer. Everything novel — backprop reflex, root↔delta
// sync, cite-scoped context loading — reuses the storage, task-thread,
// proposal, and embedding infrastructure that colony already has.

export { parseSpec, serializeSpec, type Spec, type SpecSection } from './grammar.js';
export { parseChange, serializeChange, type Change, type DeltaRow } from './change.js';
export { computeBaseRootHash, verifyBaseRootHash } from './hash.js';
export {
  SpecRepository,
  type SpecRepositoryOptions,
  type OpenChangeInput,
  type ArchiveResult,
} from './repository.js';
export { SyncEngine, type SyncStrategy, type MergeResult, type MergeConflict } from './sync.js';
export {
  BackpropGate,
  type FailureSignature,
  type PromotionDecision,
  computeFailureSignature,
} from './backprop.js';
export { resolveTaskContext, type ResolvedContext } from './context.js';
export { SPEC_OBSERVATION_KINDS, SPEC_TASK_METADATA_KEY } from './constants.js';
