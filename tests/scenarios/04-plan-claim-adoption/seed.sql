-- Queen published a plan with one sub-task. We seed the sub-task row
-- directly (so the scenario doesn't have to walk publishPlan's full
-- file-emit side effect). Agent later claims and adopts the sub-task.
INSERT INTO sessions(id, ide, cwd, started_at, metadata)
  VALUES ('queen@scenario-04', 'queen', '<REPO_ROOT>', 1778925600000, NULL);

INSERT INTO tasks(id, title, repo_root, branch, status, created_by, created_at, updated_at)
  VALUES (
    100,
    'Plan claim adoption sub-task',
    '<REPO_ROOT>',
    'spec/scenario-04-plan/sub-0',
    'open',
    'queen@scenario-04',
    1778925600000,
    1778925600000
  );

-- Queen records the plan-subtask-claim as 'pending' so the agent has
-- something to adopt. Real queen publishes also emit plan-config, but
-- that's outside the adoption assertion surface.
INSERT INTO observations(id, session_id, kind, content, compressed, intensity, ts, metadata, task_id)
  VALUES (
    1000,
    'queen@scenario-04',
    'plan-subtask-claim',
    'queen published scenario-04 sub-0',
    0,
    NULL,
    1778925600000,
    '{"kind":"plan-subtask-claim","status":"pending","plan_slug":"scenario-04-plan","subtask_index":0}',
    100
  );
