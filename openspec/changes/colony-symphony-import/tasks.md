# Tasks

Checklist rows stay unchecked until evidence is recorded inline. Agent ID ranges
are ownership hints for Waves 2-7; claim live Colony tasks before editing.

| Phase | Wave | Agent IDs | Gate |
| --- | --- | --- | --- |
| 1 | Foundation ledger | 200-202 | Docs-only umbrella open |
| 2 | Workflow contract | 203-206 | Workflow loader + config proof |
| 3 | Colony tracker intake | 207-210 | Candidate/state/terminal refresh proof |
| 4 | Workspace and attempts | 211-214 | Workspace, hook, app-server, retry proof |
| 5 | Reconciliation safety | 215-218 | Stop/cleanup proof without status-flip regression |
| 6 | Observability/control | 219-222 | Structured log and optional surface proof |
| 7 | Safety/archive | 223-229 | Production validation and archival evidence |

## 1. Wave 1 - Foundation Ledger

- [ ] Agent 200: import Symphony reference context into `openspec/specs/colony-symphony/context.md`.
- [ ] Agent 201: record domain mapping, including `Colony-as-tracker` and Linear-as-tracker N/A.
- [ ] Agent 202: create `proposal.md`, `spec.md`, `tasks.md`, and `design.md` for
  `openspec/changes/colony-symphony-import/`.
- [ ] Agent 202: verify Wave 1 with `openspec validate --specs`.
- [ ] Agent 202: record `ls openspec/changes/colony-symphony-import/` evidence.
- [ ] Agent 202: record `git diff openspec/changes/colony-symphony-import/` evidence.

## 2. Wave 2 - Workflow Contract

- [ ] Agents 203-204: implement workflow path selection, cwd default selection, and `WORKFLOW.md`
  YAML front matter plus prompt body loading.
- [ ] Agents 205-206: implement typed config defaults, `$` env indirection, and dynamic reload.
- [ ] Agents 203-206: verify workflow contract with focused unit tests.
- [ ] Agents 203-206: verify OpenSpec with `openspec validate --specs`.
- [ ] Agents 203-206: record PR URL and merge evidence before checking off the wave.

## 3. Wave 3 - Colony Tracker Intake

- [ ] Agents 207-208: map candidate fetch, state refresh, and terminal fetch onto Colony task state.
- [ ] Agents 209-210: normalize Colony task payloads into stable issue/task models.
- [ ] Agents 207-210: keep Linear GraphQL behavior out of core conformance unless a later extension
  explicitly claims it.
- [ ] Agents 207-210: verify candidate/state/terminal refresh behavior with focused tests.
- [ ] Agents 207-210: record PR URL and merge evidence before checking off the wave.

## 4. Wave 4 - Workspace And Attempts

- [ ] Agents 211-212: implement sanitized task workspaces and workspace lifecycle hooks.
- [ ] Agents 213-214: implement hook timeout config, Codex app-server JSON line launch, strict prompt
  rendering, retry queue, and retry backoff cap.
- [ ] Agents 211-214: verify workspace containment and hook timeout behavior.
- [ ] Agents 211-214: verify retry and continuation behavior with deterministic tests.
- [ ] Agents 211-214: record PR URL and merge evidence before checking off the wave.

## 5. Wave 5 - Reconciliation Safety

- [ ] Agents 215-216: implement single-authority polling state, claimed checks, and running checks.
- [ ] Agents 217-218: implement terminal/non-active stop behavior and terminal workspace cleanup.
- [ ] Agents 215-218: add regression coverage proving reconciliation does not write task status unless
  an explicit Colony write contract exists.
- [ ] Agents 215-218: verify startup sweep and active-transition cleanup.
- [ ] Agents 215-218: record PR URL and merge evidence before checking off the wave.

## 6. Wave 6 - Observability And Optional Control Surface

- [ ] Agents 219-220: implement structured logs with `issue_id`, `issue_identifier`, and `session_id`.
- [ ] Agents 221-222: add runtime snapshot/status surface only if scoped as a RECOMMENDED extension.
- [ ] Agents 219-222: verify structured log fields and operator-visible evidence.
- [ ] Agents 219-222: if an HTTP surface ships, verify CLI `--port` precedence, bind host, endpoints, and
  error semantics.
- [ ] Agents 219-222: record PR URL and merge evidence before checking off the wave.

## 7. Wave 7 - Safety And Archive

- [ ] Agents 223-225: verify target host OS/shell workflow path resolution and hook execution.
- [ ] Agents 226-227: verify no upstream Symphony Elixir code is vendored, translated, or copied into
  Colony paths.
- [ ] Agents 228-229: validate optional extension boundaries and unresolved blocker notes.
- [ ] Agents 223-229: run `openspec validate --specs` and any strict change validation required by the
  final archival lane.
- [ ] Agents 223-229: record final PR URL, `MERGED` evidence, sandbox cleanup state, and archive readiness.
