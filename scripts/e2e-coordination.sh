#!/usr/bin/env bash
# scripts/e2e-coordination.sh
#
# End-to-end smoke test for telemetry-driven coordination writes. It drives the
# published CLI hook entrypoint, reads the resulting local memory, and verifies
# the observation kinds that release coordination depends on.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${COLONY_COORDINATION_WORK:-$REPO/.e2e/coordination}"
HOME_DIR="${COLONY_E2E_HOME:-$WORK/home}"
COLONY_DATA_DIR="${COLONY_HOME:-$HOME_DIR/.colony}"

cleanup() {
  rm -rf "$WORK"
}
cleanup
mkdir -p "$WORK" "$HOME_DIR" "$COLONY_DATA_DIR"

if [[ -n "${COLONY_BIN:-}" ]]; then
  COLONY_CMD=("$COLONY_BIN")
elif [[ -f "$REPO/apps/cli/dist/index.js" ]]; then
  COLONY_CMD=("node" "$REPO/apps/cli/dist/index.js")
elif command -v colony >/dev/null 2>&1; then
  COLONY_CMD=("$(command -v colony)")
else
  echo "COLONY_BIN is unset and no built colony CLI was found" >&2
  exit 1
fi

export HOME="$HOME_DIR"
export COLONY_HOME="$COLONY_DATA_DIR"
export COLONY_NO_AUTOSTART=1

json_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

colony() {
  "${COLONY_CMD[@]}" "$@"
}

run_hook() {
  local hook_name="$1"
  local payload="$2"
  printf '%s\n' "$payload" | colony hook run "$hook_name" --ide codex >/dev/null
}

SESSION="e2e-coordination-$$"
SESSION_JSON="$(json_quote "$SESSION")"
FIXTURE="$WORK/repo"
mkdir -p "$FIXTURE/src"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "e2e@example.invalid"
git -C "$FIXTURE" config user.name "Colony E2E"
printf 'old\n' >"$FIXTURE/old.ts"
git -C "$FIXTURE" add old.ts
git -C "$FIXTURE" commit -q -m "init"

FIXTURE_JSON="$(json_quote "$FIXTURE")"
EDIT_FILE_JSON="$(json_quote "$FIXTURE/src/coordination-smoke.ts")"
BASH_COMMAND_JSON="$(json_quote "git checkout -b coordination-smoke && rm old.ts")"
TASK_TITLE_JSON="$(json_quote "Coordinate release smoke test")"

echo "==> coordination smoke: SessionStart"
run_hook "session-start" "{\"session_id\":$SESSION_JSON,\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":$FIXTURE_JSON}"

echo "==> coordination smoke: Edit auto-claim"
run_hook "post-tool-use" "{\"session_id\":$SESSION_JSON,\"hook_event_name\":\"PostToolUse\",\"cwd\":$FIXTURE_JSON,\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":$EDIT_FILE_JSON},\"tool_response\":{\"success\":true}}"

echo "==> coordination smoke: Bash git/file observations"
run_hook "post-tool-use" "{\"session_id\":$SESSION_JSON,\"hook_event_name\":\"PostToolUse\",\"cwd\":$FIXTURE_JSON,\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$BASH_COMMAND_JSON},\"tool_response\":{\"exit_code\":0}}"

echo "==> coordination smoke: TaskCreate mirror"
run_hook "post-tool-use" "{\"session_id\":$SESSION_JSON,\"hook_event_name\":\"PostToolUse\",\"cwd\":$FIXTURE_JSON,\"tool_name\":\"TaskCreate\",\"tool_input\":{\"title\":$TASK_TITLE_JSON,\"prompt\":\"verify release coordination\"},\"tool_response\":{\"task_id\":\"coordination-smoke\"}}"

DB="$COLONY_HOME/data.db"
DEBRIEF="$WORK/debrief.json"

echo "==> coordination smoke: verify observations"

node - "$DB" "$SESSION" "$REPO" <<'NODE'
const { createRequire } = require('node:module');
const [dbFile, session, repo] = process.argv.slice(2);
const requireFromCli = createRequire(`${repo}/apps/cli/package.json`);
const Database = requireFromCli('better-sqlite3');
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const observations = db
  .prepare(
    `SELECT id, session_id, kind, content, metadata
       FROM observations
      WHERE session_id = ?
      ORDER BY id`,
  )
  .all(session);
const byKind = new Map();
for (const obs of observations) {
  const bucket = byKind.get(obs.kind) ?? [];
  bucket.push(obs);
  byKind.set(obs.kind, bucket);
}
for (const kind of ['auto-claim', 'git-op', 'file-op', 'task-create-mirror']) {
  if (!byKind.has(kind)) {
    throw new Error(`missing ${kind} observation for ${session}`);
  }
}
if (!byKind.get('auto-claim').some((obs) => obs.content.includes('coordination-smoke.ts'))) {
  throw new Error('auto-claim observation did not name edited file');
}
if (!byKind.get('git-op').some((obs) => obs.content.includes('checkout'))) {
  throw new Error('git-op observation did not record checkout');
}
if (!byKind.get('file-op').some((obs) => obs.content.includes('old.ts'))) {
  throw new Error('file-op observation did not record rm target');
}
if (!byKind.get('task-create-mirror').some((obs) => obs.content.includes('Coordinate release smoke test'))) {
  throw new Error('task-create-mirror observation did not record task title');
}
NODE

echo "==> coordination smoke: debrief --json"
colony debrief --json --hours 1 >"$DEBRIEF"

node - "$DEBRIEF" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const key of [
  'tool_usage',
  'auto_join',
  'claim_coverage',
  'proactive_claims',
  'handoffs',
  'tool_distribution',
  'coordination_ratio',
  'bash_coordination_volume',
  'timeline',
]) {
  if (!(key in payload)) throw new Error(`debrief JSON missing ${key}`);
}
if (payload.claim_coverage.edit_count < 1 || payload.claim_coverage.auto_claim_count < 1) {
  throw new Error('debrief JSON claim_coverage did not include the Edit auto-claim');
}
if (!Array.isArray(payload.tool_distribution)) {
  throw new Error('debrief JSON tool_distribution is not an array');
}
if (!payload.tool_distribution.some((row) => row.tool === 'Edit')) {
  throw new Error('debrief JSON tool_distribution missed Edit');
}
if (!payload.tool_distribution.some((row) => row.tool === 'Bash')) {
  throw new Error('debrief JSON tool_distribution missed Bash');
}
if (!Array.isArray(payload.timeline)) {
  throw new Error('debrief JSON timeline is not an array');
}
if (payload.bash_coordination_volume.git_op_count < 1) {
  throw new Error('debrief JSON bash_coordination_volume missed git-op');
}
if (payload.bash_coordination_volume.file_op_count < 1) {
  throw new Error('debrief JSON bash_coordination_volume missed file-op');
}
NODE

echo "COORDINATION SMOKE PASSED"
cleanup
