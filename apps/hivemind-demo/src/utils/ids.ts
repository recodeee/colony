export function createRunId(now: Date = new Date()): string {
  return `run-${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
}

export function createMessageId(turn: number): string {
  return `msg-${String(turn).padStart(2, '0')}`;
}

export function createArtifactId(type: string, index: number): string {
  return `${type}-${String(index).padStart(2, '0')}`;
}

export function createCheckpointId(index: number): string {
  return `checkpoint-${String(index).padStart(2, '0')}`;
}
