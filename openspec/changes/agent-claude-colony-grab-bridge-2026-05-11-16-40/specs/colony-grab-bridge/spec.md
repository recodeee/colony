## ADDED Requirements

### Requirement: localhost grab intake daemon

`colony grab serve` SHALL run a long-lived HTTP daemon that accepts
react-grab submit payloads on a single route, converts each accepted payload
into a colony task on a fresh `agent/*` branch worktree, and starts a
detached tmux session running `codex` inside that worktree.

#### Scenario: Successful submit produces a task, worktree, and tmux session

- **WHEN** a client sends `POST /grab` with a valid bearer token, an
  allowed `Origin`, `Content-Type: application/json`, and a body containing
  `source: "react-grab"`, a non-empty `payload.content`, and an optional
  `extra_prompt`
- **THEN** the daemon SHALL invoke `gx branch start --tier T1 "<slug>"
  "react-grab"` from `--repo`, create a colony task via
  `storage.findOrCreateTask({ title, repo_root, branch, created_by:
  "react-grab" })`, post the payload body as a `kind: "note"` observation
  on the resulting task thread, write `INTAKE.md` into the worktree root
  with the prompt and metadata, start a detached
  `tmux new-session -d -s "rg-<task_id>" -c "<worktree>" codex`,
  and return `200` with body
  `{ task_id, branch, worktree, tmux_session, action: "spawned" }`.

#### Scenario: Duplicate submit within the dedup window posts a note on the existing task

- **WHEN** a second `POST /grab` arrives whose
  `sha256(repo_root|file_path|content|extra_prompt)` matches a prior
  accepted submit within the dedup window (default 5 minutes)
- **THEN** the daemon SHALL NOT create a new worktree or tmux session,
  SHALL post the new payload as a `kind: "note"` observation on the
  existing task, and SHALL return `200` with body
  `{ task_id, action: "appended" }`.

### Requirement: request gating defends against browser CSRF and unauthenticated callers

The daemon SHALL apply, in order, the following gates and reject any
request that fails any one of them. Rejected requests SHALL NOT spawn
worktrees, write to storage, or echo payload contents.

1. Bind to `127.0.0.1` only; never accept a connection on a non-loopback
   interface.
2. `Content-Type` SHALL equal `application/json`; otherwise `415`.
3. `Origin` header SHALL be present and SHALL match the configured
   allowlist; otherwise `403`.
4. `Authorization` header SHALL equal `Bearer <token>` for the token
   generated at `serve` start; otherwise `401`.

#### Scenario: Non-loopback connection is refused at the socket

- **WHEN** a peer connects from an interface other than `127.0.0.1`
- **THEN** the daemon SHALL refuse the connection at bind time (the
  server SHALL NOT listen on `0.0.0.0` or any LAN address).

#### Scenario: Missing or wrong Content-Type returns 415

- **WHEN** `POST /grab` has `Content-Type: text/plain` or no
  `Content-Type` header
- **THEN** the daemon SHALL return `415` and a JSON body
  `{ code: "unsupported_media_type" }`.

#### Scenario: Missing or non-allowlisted Origin returns 403

- **WHEN** `POST /grab` is sent without an `Origin` header, or with an
  `Origin` that is not in the allowlist supplied to `serve`
- **THEN** the daemon SHALL return `403` and a JSON body
  `{ code: "origin_not_allowed" }`.

#### Scenario: Missing or wrong Authorization returns 401

- **WHEN** `POST /grab` is sent without `Authorization: Bearer <token>`
  or with a token that does not match the configured token
- **THEN** the daemon SHALL return `401` and a JSON body
  `{ code: "unauthorized" }`.

### Requirement: state files live under COLONY_HOME and never leak the token in logs

The daemon SHALL persist its bind config, token, recent dedup hashes, and
spawned tmux session names to a file under
`$COLONY_HOME/grab/<token-fingerprint>.json`. The file SHALL be created
with mode `0600`. The token value SHALL NOT appear in stdout, stderr, or
any structured log line; only the SHA-256 fingerprint of the token SHALL
appear in logs.

#### Scenario: Token never appears in logs

- **WHEN** the daemon writes a startup log line, a request log line, or
  an error log line
- **THEN** the log line SHALL NOT contain the raw token string and SHALL
  reference the token only by its SHA-256 fingerprint (first 12 hex chars).
