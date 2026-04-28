import type { PublishPlanResult, PublishPlanSubtaskInput } from '@colony/spec';

export interface PlanPublishWave {
  wave_index: number;
  name: string;
  subtask_indexes: number[];
  subtasks: Array<{ subtask_index: number; title: string; branch: string; task_id: number }>;
}

export interface PlanClaimInstruction {
  subtask_index: number;
  title: string;
  branch: string;
  tool: 'task_plan_claim_subtask';
  arguments: {
    plan_slug: string;
    subtask_index: number;
    session_id: '<claiming-session-id>';
    agent: '<agent-name>';
  };
  ready_when: 'now' | 'dependencies_completed';
}

export interface GuidedPublishPlanResult extends PublishPlanResult {
  waves: PlanPublishWave[];
  claim_instructions: PlanClaimInstruction[];
}

export function withPlanPublishGuidance(
  result: PublishPlanResult,
  subtasks: PublishPlanSubtaskInput[],
  options: { wave_names?: string[] | undefined } = {},
): GuidedPublishPlanResult {
  const waveIndexes = computeWaveIndexes(subtasks);
  const subtasksByIndex = new Map(
    result.subtasks.map((subtask) => [subtask.subtask_index, subtask]),
  );
  const maxWave = waveIndexes.length > 0 ? Math.max(...waveIndexes) : -1;
  const waves: PlanPublishWave[] = [];

  for (let waveIndex = 0; waveIndex <= maxWave; waveIndex++) {
    const subtaskIndexes = waveIndexes
      .map((candidateWave, subtaskIndex) => (candidateWave === waveIndex ? subtaskIndex : -1))
      .filter((subtaskIndex) => subtaskIndex >= 0);
    if (subtaskIndexes.length === 0) continue;
    waves.push({
      wave_index: waveIndex,
      name: options.wave_names?.[waveIndex] ?? `Wave ${waveIndex + 1}`,
      subtask_indexes: subtaskIndexes,
      subtasks: subtaskIndexes
        .map((subtaskIndex) => subtasksByIndex.get(subtaskIndex))
        .filter(
          (subtask): subtask is PublishPlanResult['subtasks'][number] => subtask !== undefined,
        ),
    });
  }

  return {
    ...result,
    waves,
    claim_instructions: result.subtasks.map((subtask) => ({
      subtask_index: subtask.subtask_index,
      title: subtask.title,
      branch: subtask.branch,
      tool: 'task_plan_claim_subtask',
      arguments: {
        plan_slug: result.plan_slug,
        subtask_index: subtask.subtask_index,
        session_id: '<claiming-session-id>',
        agent: '<agent-name>',
      },
      ready_when:
        (subtasks[subtask.subtask_index]?.depends_on ?? []).length === 0
          ? 'now'
          : 'dependencies_completed',
    })),
  };
}

function computeWaveIndexes(subtasks: PublishPlanSubtaskInput[]): number[] {
  const memo = new Map<number, number>();
  const visiting = new Set<number>();

  function waveFor(index: number): number {
    const cached = memo.get(index);
    if (cached !== undefined) return cached;
    if (visiting.has(index)) return 0;
    visiting.add(index);

    const deps = (subtasks[index]?.depends_on ?? []).filter(
      (dep) => Number.isInteger(dep) && dep >= 0 && dep < subtasks.length,
    );
    const wave = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => waveFor(dep) + 1));

    visiting.delete(index);
    memo.set(index, wave);
    return wave;
  }

  return subtasks.map((_, index) => waveFor(index));
}
