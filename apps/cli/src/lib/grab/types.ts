// Wire format and config types for the `colony grab` daemon.
//
// The daemon is a per-project localhost HTTP intake that turns a react-grab
// "Add context" submit into a colony task on a fresh `agent/*` worktree and
// starts a detached tmux session running codex inside it.

export interface ReactGrabEntry {
  tagName?: string;
  componentName?: string;
  content: string;
  commentText?: string;
}

export interface ReactGrabPayload {
  version?: string;
  content: string;
  entries?: ReactGrabEntry[];
  timestamp?: number;
}

export interface GrabSubmitBody {
  source: 'react-grab';
  payload: ReactGrabPayload;
  extra_prompt?: string;
  viewport_url?: string;
}

export interface GrabServeConfig {
  /** Absolute path to the project's primary checkout. */
  repoRoot: string;
  /** Bind port; `0` selects a free port. */
  port: number;
  /** Bearer token; client must send `Authorization: Bearer <token>`. */
  token: string;
  /** Allowed `Origin` header values (exact match). */
  originAllowlist: readonly string[];
  /** Dedup window for repeated submits of the same hash. */
  dedupWindowMs: number;
  /** Directory for state files (default `$COLONY_HOME/grab`). */
  colonyHome: string;
  /** Tier passed to `gx branch start`. */
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  /** Injectable spawn primitives for tests. */
  spawn?: SpawnPrimitives;
}

export interface StartWorktreeArgs {
  repoRoot: string;
  slug: string;
  tier: GrabServeConfig['tier'];
}

export interface StartWorktreeResult {
  branch: string;
  worktree: string;
}

export interface StartTmuxArgs {
  session: string;
  cwd: string;
}

export interface SpawnPrimitives {
  startWorktree(args: StartWorktreeArgs): Promise<StartWorktreeResult>;
  writeIntake(worktree: string, content: string): Promise<void>;
  startTmux(args: StartTmuxArgs): Promise<void>;
}

export interface GrabSpawnSuccess {
  task_id: number;
  branch: string;
  worktree: string;
  tmux_session: string;
  action: 'spawned';
}

export interface GrabAppendSuccess {
  task_id: number;
  action: 'appended';
}

export interface GrabError {
  code: string;
  message?: string;
}
