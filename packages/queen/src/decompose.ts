export type CapabilityHint = 'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work';

export interface Goal {
  title: string;
  problem?: string;
  description?: string;
  acceptance_criteria?: string[];
  repo_root?: string;
  affected_files?: string[];
}

export interface PlanGoalOptions {
  affected_files?: string[];
}

export interface QueenSubtask {
  title: string;
  description: string;
  file_scope: string[];
  depends_on: number[];
  capability_hint: CapabilityHint;
}

export interface QueenPlan {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  subtasks: QueenSubtask[];
}

export interface QueenExecutionStrategy {
  mode: 'flat_subtasks' | 'ordered_waves';
  claim_model: 'agent_pull';
  scheduler: 'none';
  wave_dependency: 'none' | 'previous_wave';
}

export interface QueenPlanWave {
  id: string;
  title: string;
  description?: string;
  subtask_indexes: number[];
}

export interface QueenOrderedPlan extends QueenPlan {
  execution_strategy: QueenExecutionStrategy;
  waves: QueenPlanWave[];
}

export type QueenWaveSubtask = Omit<QueenSubtask, 'depends_on'> & {
  /**
   * Optional flat `task_plan` dependencies for exceptional earlier-wave edges.
   * Same-wave dependencies are intentionally rejected: sub-tasks in one wave
   * are supposed to be claimable in parallel.
   */
  depends_on?: number[];
};

export interface QueenPlanWaveInput {
  id?: string;
  title: string;
  description?: string;
  subtasks: QueenWaveSubtask[];
}

export interface QueenOrderedPlanInput {
  slug: string;
  title: string;
  problem: string;
  acceptance_criteria: string[];
  waves: QueenPlanWaveInput[];
}

interface DraftGroup {
  kind: 'storage' | 'api' | 'web' | 'infra' | 'tests' | 'docs';
  title: string;
  description: string;
  files: string[];
}

const MIN_SUBTASKS = 2;
const MAX_SUBTASKS = 7;
const COMBINING_MARKS = /\p{M}+/gu;

export function planGoal(goal: Goal, options: PlanGoalOptions = {}): QueenPlan {
  const slug = slugFromTitle(goal.title);
  const affectedFiles = normalizeFiles(
    options.affected_files ?? goal.affected_files ?? inferAffectedFiles(goal, slug),
  );
  const groups = groupFiles(goal, affectedFiles);
  const subtasks = wireDependencies(groups);

  return {
    slug,
    title: goal.title,
    problem: goal.problem ?? goal.description ?? goal.title,
    acceptance_criteria:
      goal.acceptance_criteria && goal.acceptance_criteria.length > 0
        ? [...goal.acceptance_criteria]
        : [`Complete ${goal.title}`],
    subtasks,
  };
}

export function orderedPlanFromWaves(input: QueenOrderedPlanInput): QueenOrderedPlan {
  if (input.waves.length === 0) {
    throw new Error('ordered queen plan needs at least one wave');
  }

  const subtasks: QueenSubtask[] = [];
  const waves: QueenPlanWave[] = [];
  let previousWaveIndexes: number[] = [];

  for (let waveIndex = 0; waveIndex < input.waves.length; waveIndex++) {
    const wave = input.waves[waveIndex];
    if (!wave) continue;
    if (wave.subtasks.length === 0) {
      throw new Error(`ordered queen plan wave ${waveIndex} needs at least one sub-task`);
    }

    const firstIndexInWave = subtasks.length;
    const subtaskIndexes: number[] = [];

    for (const subtask of wave.subtasks) {
      const { depends_on: explicitDependsOn = [], ...draft } = subtask;
      for (const dep of explicitDependsOn) {
        if (!Number.isInteger(dep) || dep < 0 || dep >= firstIndexInWave) {
          throw new Error(
            `ordered queen plan wave ${waveIndex} has invalid dependency ${dep}; wave subtasks may only depend on earlier waves`,
          );
        }
      }

      subtasks.push({
        ...draft,
        depends_on: uniqueSorted([...explicitDependsOn, ...previousWaveIndexes]),
      });
      subtaskIndexes.push(subtasks.length - 1);
    }

    waves.push({
      id: wave.id ?? `wave-${waveIndex + 1}`,
      title: wave.title,
      ...(wave.description !== undefined ? { description: wave.description } : {}),
      subtask_indexes: subtaskIndexes,
    });
    previousWaveIndexes = subtaskIndexes;
  }

  return {
    slug: input.slug,
    title: input.title,
    problem: input.problem,
    acceptance_criteria: [...input.acceptance_criteria],
    execution_strategy: {
      mode: 'ordered_waves',
      claim_model: 'agent_pull',
      scheduler: 'none',
      wave_dependency: 'previous_wave',
    },
    waves,
    subtasks,
  };
}

export function slugFromTitle(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const clipped = normalized.slice(0, 40).replace(/-+$/g, '');
  return clipped.length > 0 ? clipped : 'goal';
}

export function capabilityHintForFiles(files: string[]): CapabilityHint {
  if (files.some(isTestFile)) return 'test_work';
  if (files.some(isMarkdownFile)) return 'doc_work';
  if (files.some((file) => file.startsWith('apps/api/'))) return 'api_work';
  if (files.some((file) => file.startsWith('apps/web/') || file.endsWith('.tsx'))) {
    return 'ui_work';
  }
  return 'infra_work';
}

function groupFiles(goal: Goal, affectedFiles: string[]): DraftGroup[] {
  const implementationFiles = affectedFiles.filter(
    (file) => !isTestFile(file) && !isReadmeDoc(file),
  );
  const testFiles = affectedFiles.filter(isTestFile);
  const readmeFiles = affectedFiles.filter(isReadmeDoc);

  const storageFiles = implementationFiles.filter((file) => file.startsWith('packages/storage/'));
  const apiFiles = implementationFiles.filter((file) => file.startsWith('apps/api/'));
  const webFiles = implementationFiles.filter((file) => file.startsWith('apps/web/'));
  const consumed = new Set([...storageFiles, ...apiFiles, ...webFiles]);
  const otherFiles = implementationFiles.filter((file) => !consumed.has(file));

  const groups: DraftGroup[] = [];
  pushGroup(groups, {
    kind: 'storage',
    title: 'Prepare storage scope',
    description: `Update storage files for ${goal.title}.`,
    files: storageFiles,
  });
  pushGroup(groups, {
    kind: 'api',
    title: 'Implement API scope',
    description: `Update API files for ${goal.title}.`,
    files: apiFiles,
  });
  pushGroup(groups, {
    kind: 'web',
    title: 'Implement web scope',
    description: `Update web UI files for ${goal.title}.`,
    files: webFiles,
  });
  pushGroup(groups, {
    kind: 'infra',
    title: 'Update shared infrastructure scope',
    description: `Update remaining non-UI/non-API files for ${goal.title}.`,
    files: otherFiles,
  });
  pushGroup(groups, {
    kind: 'tests',
    title: 'Add targeted tests',
    description: `Add or update tests after the implementation for ${goal.title}.`,
    files: testFiles,
  });

  if (readmeFiles.length > 0 && groups.length === 0) {
    groups.push({
      kind: 'docs',
      title: 'Prepare README change',
      description: `Review README context before the final documentation update for ${goal.title}.`,
      files: readmeFiles,
    });
  }

  pushGroup(groups, {
    kind: 'docs',
    title: 'Update README documentation',
    description: `Update docs/README documentation for ${goal.title}.`,
    files: readmeFiles,
  });

  ensureMinimumGroups(groups, goal, affectedFiles);
  return groups.slice(0, MAX_SUBTASKS);
}

function wireDependencies(groups: DraftGroup[]): QueenSubtask[] {
  const storageIndex = groups.findIndex((group) => group.kind === 'storage');
  const subtasks: QueenSubtask[] = [];

  for (const group of groups) {
    const index = subtasks.length;
    const deps = new Set<number>();

    if (storageIndex >= 0 && index !== storageIndex && group.kind !== 'storage') {
      deps.add(storageIndex);
    }

    if (group.kind === 'tests') {
      for (let i = 0; i < index; i++) {
        if (groups[i]?.kind !== 'docs' && groups[i]?.kind !== 'tests') deps.add(i);
      }
    }

    if (group.kind === 'docs') {
      for (let i = 0; i < index; i++) deps.add(i);
    }

    if (index > 0 && overlapsPreviousGroup(group, groups.slice(0, index))) {
      deps.add(index - 1);
    }

    subtasks.push({
      title: group.title,
      description: group.description,
      file_scope: group.files,
      depends_on: [...deps].sort((a, b) => a - b),
      capability_hint: capabilityHintForFiles(group.files),
    });
  }

  return subtasks;
}

function ensureMinimumGroups(groups: DraftGroup[], goal: Goal, affectedFiles: string[]): void {
  if (groups.length >= MIN_SUBTASKS) return;

  const files =
    affectedFiles.length > 0 ? affectedFiles : inferAffectedFiles(goal, slugFromTitle(goal.title));
  const last = groups.at(-1);
  const fallbackKind = last?.kind ?? 'infra';
  const fallbackFiles = last?.files ?? files;

  if (fallbackKind === 'docs') {
    groups.unshift({
      kind: 'docs',
      title: 'Review documentation scope',
      description: `Review documentation context for ${goal.title}.`,
      files: fallbackFiles,
    });
    return;
  }

  groups.push({
    kind: fallbackKind,
    title: `Verify ${labelForKind(fallbackKind)} scope`,
    description: `Verify the ${labelForKind(fallbackKind)} changes for ${goal.title}.`,
    files: fallbackFiles,
  });
}

function inferAffectedFiles(goal: Goal, slug: string): string[] {
  const text = `${goal.title} ${goal.problem ?? ''} ${goal.description ?? ''}`.toLowerCase();
  if (/\b(auth|login|session|user|account)\b/.test(text)) {
    return [
      'packages/storage/src/auth.ts',
      'apps/api/src/auth.ts',
      'apps/web/src/auth/AuthPanel.tsx',
      'apps/api/test/auth.test.ts',
    ];
  }
  if (/\b(doc|docs|readme|documentation)\b/.test(text)) return ['docs/README.md'];
  if (/\b(ui|web|frontend|screen|page|component)\b/.test(text)) {
    return [`apps/web/src/${slug}.tsx`];
  }
  if (/\b(api|endpoint|route|server)\b/.test(text)) return [`apps/api/src/${slug}.ts`];
  if (/\b(storage|database|schema|migration)\b/.test(text)) {
    return [`packages/storage/src/${slug}.ts`];
  }
  return [`packages/core/src/${slug}.ts`, `packages/core/test/${slug}.test.ts`];
}

function pushGroup(groups: DraftGroup[], group: DraftGroup): void {
  if (group.files.length === 0) return;
  groups.push({ ...group, files: normalizeFiles(group.files) });
}

function normalizeFiles(files: string[]): string[] {
  return [
    ...new Set(
      files
        .map((file) => file.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/'))
        .filter((file) => file.length > 0),
    ),
  ];
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function isTestFile(file: string): boolean {
  return file.endsWith('.test.ts');
}

function isMarkdownFile(file: string): boolean {
  return file.endsWith('.md');
}

function isReadmeDoc(file: string): boolean {
  return /^docs\/README(?:\.md)?$/i.test(file);
}

function overlapsPreviousGroup(group: DraftGroup, previous: DraftGroup[]): boolean {
  const files = new Set(group.files);
  return previous.some((candidate) => candidate.files.some((file) => files.has(file)));
}

function labelForKind(kind: DraftGroup['kind']): string {
  switch (kind) {
    case 'api':
      return 'API';
    case 'docs':
      return 'documentation';
    case 'storage':
      return 'storage';
    case 'tests':
      return 'test';
    case 'web':
      return 'web';
    case 'infra':
      return 'infrastructure';
  }
}
