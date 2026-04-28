---
"@colony/core": minor
---

Add similarity search and named suggestion thresholds — sub-systems 2
and 5 of the predictive-suggestions brief.

`packages/core/src/similarity-search.ts`:

- `findSimilarTasks(store, embedder, query_embedding, options)` — naive
  linear scan over cached task embeddings, returning the top-N by
  cosine similarity. Acceptable for corpora under ~10k tasks; HNSW is
  premature until measured latency motivates it. Honors `repo_root`
  scoping, `min_similarity` floor (default 0.5), `limit` cap, and
  `exclude_task_ids` for self-exclusion when called from inside an
  existing task.
- `cosineSimilarity(a, b)` — pure dot product since
  `computeTaskEmbedding` returns unit-normalized vectors. Guards
  against dimension mismatch with a 0 result rather than throwing.
- `classifyStatus(store, task_id)` — `completed` when a `plan-archived`
  observation exists OR the most recent observation is an accepted
  handoff; `abandoned` when the latest observation is older than 7
  days; `in-progress` otherwise. Surfaces in `SimilarTask.status` so
  callers can distinguish "completed in 35m" from "abandoned after 3h"
  in the suggestion payload.

`packages/core/src/suggestion-thresholds.ts`:

- Named tunables for the suggestion layer: `SIMILARITY_FLOOR` (0.5),
  `PREFACE_INCLUSION_THRESHOLD` (0.7),
  `PREFACE_FILE_CONFIDENCE_THRESHOLD` (0.6),
  `MIN_SIMILAR_TASKS_FOR_SUGGESTION` (3), `MIN_CORPUS_SIZE` (10), and
  `ABANDONED_TASK_DAYS` (7).
- The thresholds live in one place specifically so two weeks of
  evidence from `colony debrief` can refine them without hunting
  through call sites. The brief is explicit that
  `PREFACE_INCLUSION_THRESHOLD` should not be lowered to surface more
  matches — false positives in the SessionStart preface are corrosive
  and that threshold should ratchet up over time, not down.

13 new tests cover the brief's load-bearing properties: empty corpus,
ordering, min-similarity floor, self-exclusion, repo scoping, sparse-
task skip, plus the four classifyStatus paths.

Refs: sub-systems 2 + 5 of the predictive-suggestions brief. Sub-system
3 (pattern extraction → suggestion-payload) and sub-system 4 (MCP +
CLI surface) ship in subsequent PRs.
