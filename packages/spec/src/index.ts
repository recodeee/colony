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
  MISSING_SPEC_ROOT_HASH,
  type SpecRepositoryOptions,
  type OpenChangeInput,
  type OpenChangeOptions,
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
export {
  PLAN_WORKSPACE_DIR,
  PLAN_WORKSPACE_ROLES,
  createPlanWorkspace,
  listPlanWorkspaces,
  planTaskCounts,
  planWorkspacePath,
  readPlanWorkspace,
  syncPlanWorkspaceTasks,
  type CreatePlanWorkspaceInput,
  type PlanCapabilityHint,
  type PlanTaskStatus,
  type PlanWorkspaceManifest,
  type PlanWorkspaceRole,
  type PlanWorkspaceSummary,
  type PlanWorkspaceTask,
  type PlanWorkspaceTaskInput,
} from './plan-workspace.js';
export {
  PublishPlanError,
  publishPlan,
  type PublishPlanInput,
  type PublishPlanResult,
  type PublishPlanSubtaskInput,
} from './plan-publish.js';
export {
  formatOpenSpecSyncStatus,
  openspecSyncStatus,
  type OpenSpecSyncIssue,
  type OpenSpecSyncIssueCode,
  type OpenSpecSyncSeverity,
  type OpenSpecSyncStatus,
  type OpenSpecSyncStatusInput,
  type OpenSpecSyncTaskState,
  type OpenSpecTaskSyncMetadata,
} from './openspec-sync-status.js';
export {
  hasDependencyPath,
  validateOrderedPlan,
  type OrderedPlanSubtaskInput,
  type PlanValidationErrorCode,
  type PlanValidationErrorDetail,
} from './plan-validation.js';
