export type CapabilityHint = 'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work';

export interface Goal {
  title: string;
  problem?: string;
  description?: string;
  acceptance_criteria?: string[];
  repo_root?: string;
  affected_files?: string[];
  ordering_hint?: 'wave';
  waves?: WaveHint[];
  finalizer?: string;
}

export interface PlanGoalOptions {
  affected_files?: string[];
  ordering_hint?: 'wave';
  waves?: WaveHint[];
  finalizer?: string;
}

export interface WaveHint {
  name?: string | undefined;
  files?: string[] | undefined;
  affected_files?: string[] | undefined;
  depends_on?: number[] | undefined;
  subtask_refs?: string[] | undefined;
  titles?: string[] | undefined;
  rationale?: string | undefined;
}

export type OrderingWaveHint = WaveHint;

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

interface NormalizedWaveHint {
  files: string[];
  depends_on?: number[];
}

interface WaveDraft {
  index: number;
  groups: DraftGroup[];
  depends_on?: number[];
}

interface OrderedGroups {
  groups: DraftGroup[];
  order?: Map<DraftGroup, number> | undefined;
  finalizer?: DraftGroup | undefined;
}

export class QueenOrderingHintError extends Error {
  readonly fields: string[];
  readonly validation_errors: string[];

  constructor(validationErrors: string[]) {
    super(`invalid queen ordering hints: ${validationErrors.join('; ')}`);
    this.name = 'QueenOrderingHintError';
    this.fields = ['ordering_hint', 'waves'];
    this.validation_errors = validationErrors;
  }
}

const MIN_SUBTASKS = 2;
const MAX_SUBTASKS = 7;
const COMBINING_MARKS = /\p{M}+/gu;

export function planGoal(goal: Goal, options: PlanGoalOptions = {}): QueenPlan {
  const slug = slugFromTitle(goal.title);
  const inputWaves = options.waves ?? goal.waves ?? [];
  const waves = normalizeWaves(inputWaves);
  const affectedFiles = normalizeFiles(
    options.affected_files ??
      goal.affected_files ??
      filesFromWaves(waves) ??
      inferAffectedFiles(goal, slug),
  );
  const groups = groupFiles(goal, affectedFiles);
  const orderingHint = options.ordering_hint ?? goal.ordering_hint;
  const finalizer = options.finalizer ?? goal.finalizer;
  const orderingGoal: Goal = {
    ...goal,
    waves: inputWaves,
    ...(orderingHint !== undefined ? { ordering_hint: orderingHint } : {}),
    ...(finalizer !== undefined ? { finalizer } : {}),
  };
  const subtasks = hasReferenceOrderingHints(orderingGoal)
    ? wireDependencies(orderGroups(groups, orderingGoal))
    : waves.length > 0
      ? wireWaveDependencies(goal, affectedFiles, waves)
      : wireDependencies({ groups });
  assertDependencyOrder(subtasks);

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
    const earlierInWave: Array<{ index: number; file_scope: string[] }> = [];

    for (const subtask of wave.subtasks) {
      const { depends_on: explicitDependsOn = [], ...draft } = subtask;
      for (const dep of explicitDependsOn) {
        if (!Number.isInteger(dep) || dep < 0 || dep >= firstIndexInWave) {
          throw new Error(
            `ordered queen plan wave ${waveIndex} has invalid dependency ${dep}; wave subtasks may only depend on earlier waves`,
          );
        }
      }

      const overlapDeps = earlierInWave
        .filter((earlier) => sharedFiles(earlier.file_scope, draft.file_scope).length > 0)
        .map((earlier) => earlier.index);
      subtasks.push({
        ...draft,
        depends_on: uniqueSorted([...explicitDependsOn, ...previousWaveIndexes, ...overlapDeps]),
      });
      const subtaskIndex = subtasks.length - 1;
      subtaskIndexes.push(subtaskIndex);
      earlierInWave.push({ index: subtaskIndex, file_scope: draft.file_scope });
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
    waves: normalizePlanWaves(waves, subtasks),
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
  const groups = draftGroupsForFiles(goal, affectedFiles, { includeDocsPrelude: true });
  ensureMinimumGroups(groups, goal, affectedFiles);
  return groups.slice(0, MAX_SUBTASKS);
}

function draftGroupsForFiles(
  goal: Goal,
  affectedFiles: string[],
  options: { includeDocsPrelude: boolean },
): DraftGroup[] {
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

  if (options.includeDocsPrelude && readmeFiles.length > 0 && groups.length === 0) {
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

  return groups;
}

function wireDependencies(ordering: OrderedGroups): QueenSubtask[] {
  const { groups } = ordering;
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

    addOrderingDependencies(deps, ordering, group, groups, index);

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

function wireWaveDependencies(
  goal: Goal,
  affectedFiles: string[],
  waves: NormalizedWaveHint[],
): QueenSubtask[] {
  const waveDrafts = buildWaveDrafts(goal, affectedFiles, waves);
  compactWaveDrafts(waveDrafts);

  const subtasks: QueenSubtask[] = [];
  const subtaskIndexesByWave = new Map<number, number[]>();

  for (const wave of waveDrafts) {
    const requiredWaveIndexes = dependencyWaveIndexes(wave, subtaskIndexesByWave);
    const deps = requiredWaveIndexes.flatMap(
      (waveIndex) => subtaskIndexesByWave.get(waveIndex) ?? [],
    );
    const waveSubtaskIndexes: number[] = [];

    for (const group of wave.groups) {
      const index = subtasks.length;
      subtasks.push({
        title: group.title,
        description: group.description,
        file_scope: group.files,
        depends_on: [...new Set(deps)].sort((a, b) => a - b),
        capability_hint: capabilityHintForFiles(group.files),
      });
      waveSubtaskIndexes.push(index);
    }

    if (waveSubtaskIndexes.length > 0) {
      subtaskIndexesByWave.set(wave.index, waveSubtaskIndexes);
    }
  }

  ensureMinimumWaveSubtasks(subtasks, goal, affectedFiles);
  return subtasks.slice(0, MAX_SUBTASKS);
}

function buildWaveDrafts(
  goal: Goal,
  affectedFiles: string[],
  waves: NormalizedWaveHint[],
): WaveDraft[] {
  const waveDrafts: WaveDraft[] = [];
  const assignedFiles = new Set<string>();

  for (let index = 0; index < waves.length; index++) {
    const wave = waves[index];
    const files = wave?.files ?? [];
    if (files.length === 0) continue;

    for (const file of files) assignedFiles.add(file);
    waveDrafts.push({
      index,
      groups: draftGroupsForFiles(goal, files, { includeDocsPrelude: false }),
      ...(wave?.depends_on !== undefined ? { depends_on: wave.depends_on } : {}),
    });
  }

  const leftoverFiles = affectedFiles.filter((file) => !assignedFiles.has(file));
  if (leftoverFiles.length > 0) {
    waveDrafts.push({
      index: waves.length,
      groups: draftGroupsForFiles(goal, leftoverFiles, { includeDocsPrelude: false }),
    });
  }

  return waveDrafts;
}

function compactWaveDrafts(waves: WaveDraft[]): void {
  while (countWaveGroups(waves) > MAX_SUBTASKS) {
    const wave = [...waves].reverse().find((candidate) => candidate.groups.length > 1);
    if (wave) {
      const right = wave.groups.pop();
      const left = wave.groups.pop();
      if (!left || !right) break;
      wave.groups.push(mergeGroups(left, right, wave.index));
      continue;
    }

    if (!mergeLastTwoWaves(waves)) break;
  }
}

function countWaveGroups(waves: WaveDraft[]): number {
  return waves.reduce((count, wave) => count + wave.groups.length, 0);
}

function mergeGroups(left: DraftGroup, right: DraftGroup, waveIndex: number): DraftGroup {
  const files = normalizeFiles([...left.files, ...right.files]);
  return {
    kind: mergedKind(files),
    title: `Complete wave ${waveIndex + 1} scope`,
    description: `${left.description} ${right.description}`,
    files,
  };
}

function mergeLastTwoWaves(waves: WaveDraft[]): boolean {
  const rightIndex = lastNonEmptyWaveIndex(waves);
  const leftIndex = lastNonEmptyWaveIndex(waves, rightIndex - 1);
  if (leftIndex < 0 || rightIndex < 0) return false;

  const left = waves[leftIndex];
  const right = waves[rightIndex];
  const leftGroup = left?.groups[0];
  const rightGroup = right?.groups[0];
  if (!left || !right || !leftGroup || !rightGroup) return false;

  left.groups = [mergeGroups(leftGroup, rightGroup, left.index)];
  const dependsOn = mergeWaveDependsOn(left.depends_on, right.depends_on);
  if (dependsOn === undefined) {
    delete left.depends_on;
  } else {
    left.depends_on = dependsOn;
  }
  waves.splice(rightIndex, 1);
  return true;
}

function lastNonEmptyWaveIndex(waves: WaveDraft[], start = waves.length - 1): number {
  for (let index = Math.min(start, waves.length - 1); index >= 0; index--) {
    if ((waves[index]?.groups.length ?? 0) > 0) return index;
  }
  return -1;
}

function mergeWaveDependsOn(left?: number[], right?: number[]): number[] | undefined {
  if (left === undefined || right === undefined) return undefined;
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function mergedKind(files: string[]): DraftGroup['kind'] {
  if (files.some(isTestFile)) return 'tests';
  if (files.some(isReadmeDoc)) return 'docs';
  if (files.some((file) => file.startsWith('packages/storage/'))) return 'storage';
  if (files.some((file) => file.startsWith('apps/api/'))) return 'api';
  if (files.some((file) => file.startsWith('apps/web/'))) return 'web';
  return 'infra';
}

function dependencyWaveIndexes(
  wave: WaveDraft,
  subtaskIndexesByWave: Map<number, number[]>,
): number[] {
  const earlierWaves = [...subtaskIndexesByWave.keys()].filter((index) => index < wave.index);
  const requested = wave.depends_on;
  if (requested === undefined) return earlierWaves;

  const earlier = new Set(earlierWaves);
  return [...new Set(requested)]
    .filter((waveIndex) => Number.isInteger(waveIndex) && earlier.has(waveIndex))
    .sort((a, b) => a - b);
}

function ensureMinimumWaveSubtasks(
  subtasks: QueenSubtask[],
  goal: Goal,
  affectedFiles: string[],
): void {
  if (subtasks.length >= MIN_SUBTASKS) return;

  const files =
    subtasks.at(0)?.file_scope ??
    (affectedFiles.length > 0
      ? affectedFiles
      : inferAffectedFiles(goal, slugFromTitle(goal.title)));
  subtasks.push({
    title: 'Verify wave scope',
    description: `Verify the ordered wave plan for ${goal.title}.`,
    file_scope: files,
    depends_on: subtasks.length > 0 ? [0] : [],
    capability_hint: capabilityHintForFiles(files),
  });
}

function normalizeWaves(waves: WaveHint[]): NormalizedWaveHint[] {
  return waves
    .map((wave) => {
      const files = normalizeFiles([...(wave.files ?? []), ...(wave.affected_files ?? [])]);
      return {
        files,
        ...(wave.depends_on !== undefined ? { depends_on: [...wave.depends_on] } : {}),
      };
    })
    .filter((wave) => wave.files.length > 0);
}

function filesFromWaves(waves: NormalizedWaveHint[]): string[] | undefined {
  const files = normalizeFiles(waves.flatMap((wave) => wave.files));
  return files.length > 0 ? files : undefined;
}

function hasReferenceOrderingHints(goal: Goal): boolean {
  return (
    goal.ordering_hint === 'wave' ||
    goal.finalizer !== undefined ||
    (goal.waves ?? []).some(
      (wave) => (wave.titles?.length ?? 0) > 0 || (wave.subtask_refs?.length ?? 0) > 0,
    )
  );
}

function orderGroups(groups: DraftGroup[], goal: Goal): OrderedGroups {
  const hasHints =
    goal.ordering_hint !== undefined ||
    (goal.waves !== undefined && goal.waves.length > 0) ||
    goal.finalizer !== undefined;
  if (!hasHints) return { groups };

  const errors: string[] = [];
  if (goal.ordering_hint !== undefined && goal.ordering_hint !== 'wave') {
    errors.push(`unsupported ordering_hint ${goal.ordering_hint}`);
  }

  const waves = goal.waves ?? [];
  const claimed = new Map<DraftGroup, number>();
  const ordered: DraftGroup[] = [];

  waves.forEach((wave, waveIndex) => {
    const fileRefs = [...(wave.files ?? []), ...(wave.affected_files ?? [])].map(
      (file) => `file:${file}`,
    );
    const refs = [...(wave.titles ?? []), ...(wave.subtask_refs ?? []), ...fileRefs]
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0);
    if (refs.length === 0) {
      errors.push(`wave ${wave.name ?? waveIndex} must include titles or subtask_refs`);
      return;
    }

    const waveGroups = uniqueGroups(refs.flatMap((ref) => resolveGroupRef(groups, ref)));
    for (const ref of refs) {
      if (resolveGroupRef(groups, ref).length === 0) {
        errors.push(`wave ${wave.name ?? waveIndex} references unknown sub-task ${ref}`);
      }
    }
    for (const group of waveGroups) {
      const previous = claimed.get(group);
      if (previous !== undefined && previous !== waveIndex) {
        errors.push(
          `sub-task ${group.title} appears in both wave ${previous} and wave ${waveIndex}`,
        );
        continue;
      }
      claimed.set(group, waveIndex);
      ordered.push(group);
    }
    errors.push(...sameWaveOverlapErrors(waveGroups, wave.name ?? String(waveIndex)));
  });

  const finalizer = goal.finalizer ? resolveFinalizer(groups, goal.finalizer, errors) : undefined;
  if (finalizer && claimed.has(finalizer)) {
    errors.push(`finalizer ${goal.finalizer} must not also appear in a wave`);
  }

  const unmentionedWave = waves.length;
  for (const group of groups) {
    if (claimed.has(group) || group === finalizer) continue;
    claimed.set(group, unmentionedWave);
    ordered.push(group);
  }

  if (finalizer) {
    claimed.set(finalizer, unmentionedWave + 1);
    ordered.push(finalizer);
  }

  if (errors.length > 0) throw new QueenOrderingHintError([...new Set(errors)]);
  return { groups: ordered, order: claimed, finalizer };
}

function addOrderingDependencies(
  deps: Set<number>,
  ordering: OrderedGroups,
  group: DraftGroup,
  groups: DraftGroup[],
  index: number,
): void {
  const order = ordering.order;
  if (!order) return;

  const groupWave = order.get(group);
  if (groupWave === undefined) return;
  for (let i = 0; i < index; i++) {
    const candidate = groups[i];
    if (!candidate) continue;
    const candidateWave = order.get(candidate);
    if (candidateWave !== undefined && candidateWave < groupWave) deps.add(i);
  }

  if (ordering.finalizer === group) {
    for (let i = 0; i < index; i++) deps.add(i);
  }
}

function resolveGroupRef(groups: DraftGroup[], ref: string): DraftGroup[] {
  const trimmed = ref.trim();
  const separator = trimmed.indexOf(':');
  if (separator > 0) {
    const prefix = normalizeRef(trimmed.slice(0, separator));
    const value = trimmed.slice(separator + 1);
    if (prefix === 'title' || prefix === 'task') return matchByTitle(groups, value);
    if (prefix === 'kind') return matchByKind(groups, value);
    if (prefix === 'capability' || prefix === 'capability_hint') {
      return matchByCapability(groups, value);
    }
    if (prefix === 'file' || prefix === 'path') return matchByFile(groups, value);
  }

  return uniqueGroups([
    ...matchByTitle(groups, trimmed),
    ...matchByKind(groups, trimmed),
    ...matchByCapability(groups, trimmed),
    ...matchByFile(groups, trimmed),
  ]);
}

function resolveFinalizer(
  groups: DraftGroup[],
  title: string,
  errors: string[],
): DraftGroup | undefined {
  const matches = matchByTitle(groups, title);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    errors.push(`finalizer references unknown sub-task ${title}`);
    return undefined;
  }
  errors.push(`finalizer ${title} matches multiple sub-tasks`);
  return undefined;
}

function matchByTitle(groups: DraftGroup[], title: string): DraftGroup[] {
  const normalized = normalizeRef(title);
  return groups.filter((group) => normalizeRef(group.title) === normalized);
}

function matchByKind(groups: DraftGroup[], kind: string): DraftGroup[] {
  const normalized = normalizeRef(kind);
  return groups.filter((group) => normalizeRef(group.kind) === normalized);
}

function matchByCapability(groups: DraftGroup[], capability: string): DraftGroup[] {
  const normalized = normalizeRef(capability);
  return groups.filter((group) => normalizeRef(capabilityHintForFiles(group.files)) === normalized);
}

function matchByFile(groups: DraftGroup[], file: string): DraftGroup[] {
  const normalized = normalizeFiles([file])[0];
  if (!normalized) return [];
  return groups.filter((group) => group.files.includes(normalized));
}

function uniqueGroups(groups: DraftGroup[]): DraftGroup[] {
  return [...new Set(groups)];
}

function sameWaveOverlapErrors(groups: DraftGroup[], waveName: string): string[] {
  const errors: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      if (!a || !b) continue;
      const shared = sharedFiles(a.files, b.files);
      if (shared.length > 0) {
        errors.push(
          `wave ${waveName} puts overlapping sub-tasks ${a.title} and ${b.title} together: ${shared.join(', ')}`,
        );
      }
    }
  }
  return errors;
}

function normalizePlanWaves(waves: QueenPlanWave[], subtasks: QueenSubtask[]): QueenPlanWave[] {
  if (!planWavesHaveScopeOverlap(waves, subtasks)) return waves;
  const waveIndexes = dependencyWaveIndexesForSubtasks(subtasks);
  const maxWave = waveIndexes.length > 0 ? Math.max(...waveIndexes) : -1;
  const normalized: QueenPlanWave[] = [];
  for (let waveIndex = 0; waveIndex <= maxWave; waveIndex++) {
    const subtaskIndexes = waveIndexes
      .map((candidate, subtaskIndex) => (candidate === waveIndex ? subtaskIndex : -1))
      .filter((subtaskIndex) => subtaskIndex >= 0);
    if (subtaskIndexes.length === 0) continue;
    normalized.push({
      id: `wave-${waveIndex + 1}`,
      title: `Wave ${waveIndex + 1}`,
      subtask_indexes: subtaskIndexes,
    });
  }
  return normalized;
}

function planWavesHaveScopeOverlap(waves: QueenPlanWave[], subtasks: QueenSubtask[]): boolean {
  return waves.some((wave) => {
    for (let i = 0; i < wave.subtask_indexes.length; i++) {
      for (let j = i + 1; j < wave.subtask_indexes.length; j++) {
        const left = subtasks[wave.subtask_indexes[i] ?? -1];
        const right = subtasks[wave.subtask_indexes[j] ?? -1];
        if (!left || !right) continue;
        if (sharedFiles(left.file_scope, right.file_scope).length > 0) return true;
      }
    }
    return false;
  });
}

function dependencyWaveIndexesForSubtasks(subtasks: QueenSubtask[]): number[] {
  const memo = new Map<number, number>();

  function waveFor(index: number): number {
    const cached = memo.get(index);
    if (cached !== undefined) return cached;
    const deps = subtasks[index]?.depends_on ?? [];
    const wave = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => waveFor(dep) + 1));
    memo.set(index, wave);
    return wave;
  }

  return subtasks.map((_, index) => waveFor(index));
}

function sharedFiles(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((file) => rightSet.has(file)))];
}

function assertDependencyOrder(subtasks: QueenSubtask[]): void {
  const errors: string[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (const dep of subtasks[i]?.depends_on ?? []) {
      if (dep >= i) {
        errors.push(
          `sub-task ${i} depends on ${dep}; ordering hints would place required work later`,
        );
      }
    }
  }
  if (errors.length > 0) throw new QueenOrderingHintError(errors);
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

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
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
