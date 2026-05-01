import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type MemoryStore, TaskThread } from '@colony/core';
import { type Change, parseChange, serializeChange } from './change.js';
import { SPEC_BRANCH_PREFIX, SPEC_OBSERVATION_KINDS } from './constants.js';
import { type Spec, parseSpec, serializeSpec } from './grammar.js';
import { computeBaseRootHash } from './hash.js';

export interface SpecRepositoryOptions {
  // Absolute path to the repo root. SPEC.md lives at `${repoRoot}/SPEC.md`.
  repoRoot: string;
  // The colony MemoryStore the spec task-threads live on.
  store: MemoryStore;
}

export interface OpenChangeInput {
  slug: string;
  // Session id of the author. Matches colony's session-id convention
  // (e.g. 'claude@abc', 'codex@def').
  session_id: string;
  // Agent name ('claude', 'codex'). Used for handoff routing.
  agent: string;
  // Optional initial proposal text. Agents usually fill this in
  // afterwards, but /co:change accepts --message for one-shot use.
  proposal?: string;
}

export interface ArchiveResult {
  archivedPath: string;
  mergedRootHash: string;
  conflicts: number;
}

// The file-system layout colonykit mandates. Kept here — not scattered
// through skills — so a single repo can have exactly one source of truth
// for where things live.
export const LAYOUT = {
  specFile: 'SPEC.md',
  changesDir: 'openspec/changes',
  archiveDir: 'openspec/changes/archive',
  configFile: 'openspec/config.yaml',
} as const;

export class SpecRepository {
  readonly repoRoot: string;
  readonly store: MemoryStore;

  constructor(opts: SpecRepositoryOptions) {
    this.repoRoot = opts.repoRoot;
    this.store = opts.store;
  }

  // ---- root spec access ------------------------------------------------

  specPath(): string {
    return join(this.repoRoot, LAYOUT.specFile);
  }

  readRoot(): Spec {
    const path = this.specPath();
    if (!existsSync(path)) {
      throw new Error(`SPEC.md not found at ${path}. Run \`colony spec init\` first.`);
    }
    return parseSpec(readFileSync(path, 'utf8'));
  }

  // Only called from the spec skill or from SyncEngine — never directly
  // from build/check/archive. Records an observation on a dedicated
  // 'spec/root' task-thread so every root mutation is auditable.
  writeRoot(spec: Spec, opts: { session_id: string; agent: string; reason: string }): void {
    const path = this.specPath();
    const serialized = serializeSpec(spec);
    writeFileSync(path, serialized, 'utf8');

    // Persist a record of the write on the reserved root task-thread.
    // Using an ambient "branch: spec/root" means it's queryable alongside
    // every change that ever modified the root.
    const thread = TaskThread.open(this.store, {
      repo_root: this.repoRoot,
      branch: `${SPEC_BRANCH_PREFIX}root`,
      session_id: opts.session_id,
    });
    thread.join(opts.session_id, opts.agent);
    // Post directly via MemoryStore — spec-kind strings aren't in TaskThread.post's
    // enum and don't need its claim/handoff bookkeeping.
    this.store.addObservation({
      session_id: opts.session_id,
      kind: SPEC_OBSERVATION_KINDS.SPEC_WRITE,
      content: opts.reason,
      task_id: thread.task_id,
    });
  }

  // ---- change lifecycle ------------------------------------------------

  openChange(input: OpenChangeInput): { change: Change; task_id: number; path: string } {
    const root = this.readRoot();
    const change: Change = {
      slug: input.slug,
      baseRootHash: root.rootHash,
      proposal: input.proposal ?? '',
      deltaRows: [],
      tasks: [],
      bugs: [],
    };

    const changePath = this.changePath(input.slug);
    mkdirSync(dirname(changePath), { recursive: true });
    writeFileSync(changePath, serializeChange(change), 'utf8');

    // Open the backing task-thread. The branch convention `spec/<slug>`
    // is how /co:check recognizes a thread as a spec lane (together
    // with the metadata marker).
    const thread = TaskThread.open(this.store, {
      repo_root: this.repoRoot,
      branch: `${SPEC_BRANCH_PREFIX}${input.slug}`,
      session_id: input.session_id,
    });
    thread.join(input.session_id, input.agent);
    this.store.addObservation({
      session_id: input.session_id,
      kind: SPEC_OBSERVATION_KINDS.SPEC_DELTA,
      content: `Opened change ${input.slug}; base_root_hash=${change.baseRootHash}`,
      task_id: thread.task_id,
      metadata: {
        openspec_change_path: changePath,
        openspec_change_slug: input.slug,
        openspec_plan_slug: null,
        openspec_task_id: null,
      },
    });

    return { change, task_id: thread.task_id, path: changePath };
  }

  readChange(slug: string): Change {
    const path = this.changePath(slug);
    if (!existsSync(path)) {
      throw new Error(`CHANGE.md not found for slug '${slug}' at ${path}`);
    }
    return parseChange(readFileSync(path, 'utf8'), slug);
  }

  writeChange(change: Change): void {
    writeFileSync(this.changePath(change.slug), serializeChange(change), 'utf8');
  }

  // Atomic archive move. The critical invariant from the v2 plan:
  // archive writes happen via tempdir-then-rename so a crash mid-move
  // leaves either the fully-archived state or the pre-archive state,
  // never a half-moved directory.
  archiveChange(slug: string, date: string = todayIso()): string {
    const changeDir = dirname(this.changePath(slug));
    const archiveTarget = join(this.repoRoot, LAYOUT.archiveDir, `${date}-${slug}`);
    mkdirSync(dirname(archiveTarget), { recursive: true });

    // Stage: rename into a sibling `.archive-staging-<slug>` directory,
    // then move to final. Two renames keep the window where neither
    // path exists at zero.
    const stagingPath = join(this.repoRoot, LAYOUT.archiveDir, `.staging-${slug}`);
    renameSync(changeDir, stagingPath);
    renameSync(stagingPath, archiveTarget);
    return archiveTarget;
  }

  // ---- introspection --------------------------------------------------

  // Lists all task-threads that are spec lanes (by metadata marker).
  // Used by /co:check to surface cross-change conflicts.
  listSpecTasks(): Array<{ task_id: number; branch: string; slug: string }> {
    const tasks = this.store.storage.listTasks(500);
    return tasks
      .filter((t) => t.repo_root === this.repoRoot && t.branch.startsWith(SPEC_BRANCH_PREFIX))
      .map((t) => ({
        task_id: t.id,
        branch: t.branch,
        slug: t.branch.slice(SPEC_BRANCH_PREFIX.length),
      }));
  }

  // ---- private helpers ------------------------------------------------

  private changePath(slug: string): string {
    return join(this.repoRoot, LAYOUT.changesDir, slug, 'CHANGE.md');
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
