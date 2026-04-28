# Add Local Neighborhood Context

## Why

Agents need ant-style local traces around the task and files they are about to
touch. The overview `hivemind_context` is compact, but edit decisions still need
a smaller neighborhood view that combines current task, exact file claims,
nearby pheromones, memory hits, and attention blockers without browsing global
task lists.

## What Changes

- Extend `hivemind_context` with `mode: "local"`, optional `task_id`, and
  optional `files`.
- Add a `local_context` payload with current task, matching claims, pheromone
  trails, negative pheromones, compact memory hits, attention counts/IDs, and a
  ready next action.
- Keep all bodies behind `get_observations`.

## Impact

Agents can make local edit decisions with one compact repo/task/file-scoped
response instead of opening global task lists or timelines.
