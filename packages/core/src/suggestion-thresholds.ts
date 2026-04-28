// Named tunables for the predictive-suggestion layer. Centralizing them
// here means two weeks of evidence from `colony debrief` can refine the
// defaults without hunting through call sites. See the
// "predictive suggestions" brief for the load-bearing rationale.
//
// Do NOT lower PREFACE_INCLUSION_THRESHOLD to surface more suggestions in
// the SessionStart preface. False positives in the preface are corrosive —
// agents who get noisy suggestions stop reading them, which destroys the
// feature's value permanently. If anything, this threshold should ratchet
// *up* over time as we learn what good matches look like.
export const SUGGESTION_THRESHOLDS = {
  // Minimum cosine similarity for a task to count as "similar" at all.
  // Below this floor the match is just embedding-space noise.
  SIMILARITY_FLOOR: 0.5,

  // Minimum cosine similarity for the top match to trigger SessionStart
  // preface inclusion. The brief flags this as the load-bearing UX call.
  PREFACE_INCLUSION_THRESHOLD: 0.7,

  // Minimum confidence for a "files likely claimed first" entry to
  // appear in the preface. Confidence is appears-in-count / total
  // similar tasks, dampened by sample size.
  PREFACE_FILE_CONFIDENCE_THRESHOLD: 0.6,

  // Minimum number of similar tasks above the floor before any
  // suggestion is made. Below this, the response sets
  // `insufficient_data_reason` and skips structured fields.
  MIN_SIMILAR_TASKS_FOR_SUGGESTION: 3,

  // Minimum total tasks in the corpus for the colony to be considered
  // "experienced enough" to suggest anything. Below this, similarity
  // doesn't mean what we want it to mean.
  MIN_CORPUS_SIZE: 10,
} as const;

// Days since the last observation before a task is considered abandoned
// (vs. in-progress). The threshold is conservative — most active tasks
// see at least one observation per day, so a week of silence is a strong
// signal the lane stalled.
export const ABANDONED_TASK_DAYS = 7;
