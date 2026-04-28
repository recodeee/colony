export { MemoryStore, type Embedder } from './memory-store.js';
export {
  rescueStrandedSessions,
  type StrandedRescueOptions,
  type StrandedRescueOutcome,
} from './stranded-rescue.js';
export {
  readHivemind,
  type HivemindActivity,
  type HivemindOptions,
  type HivemindSession,
  type HivemindSnapshot,
} from './hivemind.js';
export { hybridRank } from './ranker.js';
export type { SearchResult, GetObservationsOptions, Observation, Session } from './types.js';
export { createSessionId } from './ids.js';
export { inferIdeFromSessionId } from './infer-ide.js';
export {
  TaskThread,
  TaskThreadError,
  TASK_THREAD_ERROR_CODES,
  isBroadcastMessage,
  isMessageAddressedTo,
  isVisibleToBroadcastClaimant,
  type CoordinationKind,
  type HandoffMetadata,
  type HandoffObservation,
  type HandoffStatus,
  type HandoffTarget,
  type HandOffArgs,
  type MessageMetadata,
  type MessageObservation,
  type MessageStatus,
  type MessageTarget,
  type MessageUrgency,
  type PostMessageArgs,
  type RelayArgs,
  type RelayMetadata,
  type RelayObservation,
  type RelayReason,
  type RelayStatus,
  type RelayTarget,
  type RequestWakeArgs,
  type TaskThreadErrorCode,
  type WakeRequestMetadata,
  type WakeRequestObservation,
  type WakeStatus,
  type WakeTarget,
} from './task-thread.js';
export {
  listMessagesForAgent,
  type ListMessagesOptions,
  type MessageSummary,
} from './messages.js';
export {
  buildAttentionInbox,
  type AttentionInbox,
  type AttentionInboxOptions,
  type CoalescedMessageGroup,
  type InboxHandoff,
  type InboxLane,
  type InboxMessage,
  type InboxRecentClaim,
  type InboxWake,
  type ReadReceipt,
} from './attention-inbox.js';
export { detectRepoBranch } from './git-detect.js';
export {
  PheromoneSystem,
  type PheromoneStrengthBySession,
  type PheromoneTrail,
} from './pheromone.js';
export {
  ProposalSystem,
  type ForagingReport,
  type PendingProposal,
  type PromotedProposal,
} from './proposal-system.js';
export {
  DEFAULT_CAPABILITIES,
  loadProfile,
  rankCandidates,
  saveProfile,
  scoreHandoff,
  type AgentCapabilities,
  type AgentProfile,
  type CandidateScore,
} from './response-thresholds.js';
export {
  areDepsMet,
  findSubtaskBySpecRow,
  listPlans,
  readSubtaskByBranch,
  type ListPlansOptions,
  type PlanInfo,
  type SubtaskInfo,
  type SubtaskLookup,
  type SubtaskStatus,
} from './plan.js';
export {
  CACHE_DRIFT_TOLERANCE,
  KIND_WEIGHTS,
  MIN_EMBEDDED_OBSERVATIONS,
  computeTaskEmbedding,
  getOrComputeTaskEmbedding,
} from './task-embeddings.js';
export {
  findSimilarTasks,
  type FindSimilarTasksOptions,
  type SimilarTaskResult,
  type SimilarTaskStatus,
} from './similarity-search.js';
export {
  buildSuggestionPayload,
  insufficientSuggestionPayload,
  type FirstFileLikelyClaimed,
  type PatternToWatch,
  type PatternToWatchKind,
  type ResolutionHints,
  type SimilarTask,
  type SuggestionPayload,
  type TaskStatus,
} from './suggestion-payload.js';
export {
  ABANDONED_TASK_DAYS,
  MIN_CORPUS_SIZE,
  MIN_SIMILAR_TASKS_FOR_SUGGESTION,
  PREFACE_FILE_CONFIDENCE_THRESHOLD,
  PREFACE_INCLUSION_THRESHOLD,
  SIMILARITY_FLOOR,
  SUGGESTION_THRESHOLDS,
} from './suggestion-thresholds.js';
