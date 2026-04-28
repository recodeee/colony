import type { ToolCallRow } from '@colony/storage';

const BRIDGE_CONVERSIONS = [
  ['hivemind_context', 'attention_inbox'],
  ['attention_inbox', 'task_ready_for_agent'],
] as const;

export type BridgeConversionName =
  | 'hivemind_context_to_attention_inbox'
  | 'attention_inbox_to_task_ready_for_agent';

export interface BridgeConversionMetric {
  from_tool: string;
  to_tool: string;
  from_calls: number;
  to_calls: number;
  from_sessions: number;
  converted_sessions: number;
  conversion_rate: number | null;
}

export interface TaskListWithoutReadyMetric {
  task_list_calls: number;
  task_ready_for_agent_calls: number;
  task_list_calls_without_task_ready_for_agent: number;
  sessions_with_task_list_without_task_ready_for_agent: number;
  task_ready_share: number | null;
}

export interface WorkingNotesBridgeMetric {
  status: 'available' | 'unavailable';
  omx_notepad_write_working_calls: number;
  colony_working_note_calls: number;
  task_post_calls: number;
  task_note_working_calls: number;
  colony_share: number | null;
}

export interface StatusReadsBridgeMetric {
  status: 'available' | 'unavailable';
  omx_state_get_status_calls: number;
  bridge_status_calls: number;
  hivemind_context_calls: number;
  colony_status_read_calls: number;
  colony_share: number | null;
}

export interface BridgeAdoptionMetrics {
  conversions: Record<BridgeConversionName, BridgeConversionMetric>;
  task_list_without_task_ready_for_agent: TaskListWithoutReadyMetric;
  working_notes: WorkingNotesBridgeMetric;
  status_reads: StatusReadsBridgeMetric;
}

export function buildBridgeAdoptionMetrics(calls: ToolCallRow[]): BridgeAdoptionMetrics {
  const conversions = Object.fromEntries(
    BRIDGE_CONVERSIONS.map(([from, to]) => [conversionKey(from, to), conversion(calls, from, to)]),
  ) as Record<BridgeConversionName, BridgeConversionMetric>;

  return {
    conversions,
    task_list_without_task_ready_for_agent: taskListWithoutReady(calls),
    working_notes: workingNotes(calls),
    status_reads: statusReads(calls),
  };
}

function conversion(
  calls: ToolCallRow[],
  fromTool: string,
  toTool: string,
): BridgeConversionMetric {
  const bySession = callsBySession(calls);
  let fromSessions = 0;
  let convertedSessions = 0;

  for (const sessionCalls of bySession.values()) {
    const firstFrom = sessionCalls.find((call) => isColonyTool(call.tool, fromTool));
    if (!firstFrom) continue;
    fromSessions++;
    if (sessionCalls.some((call) => call.ts > firstFrom.ts && isColonyTool(call.tool, toTool))) {
      convertedSessions++;
    }
  }

  return {
    from_tool: fromTool,
    to_tool: toTool,
    from_calls: countColonyTool(calls, fromTool),
    to_calls: countColonyTool(calls, toTool),
    from_sessions: fromSessions,
    converted_sessions: convertedSessions,
    conversion_rate: ratio(convertedSessions, fromSessions),
  };
}

function taskListWithoutReady(calls: ToolCallRow[]): TaskListWithoutReadyMetric {
  const bySession = callsBySession(calls);
  let taskListWithoutReady = 0;
  const sessionsWithTaskListWithoutReady = new Set<string>();

  for (const [sessionId, sessionCalls] of bySession) {
    for (const call of sessionCalls) {
      if (!isColonyTool(call.tool, 'task_list')) continue;
      const hasLaterReady = sessionCalls.some(
        (candidate) =>
          candidate.ts > call.ts && isColonyTool(candidate.tool, 'task_ready_for_agent'),
      );
      if (hasLaterReady) continue;
      taskListWithoutReady++;
      sessionsWithTaskListWithoutReady.add(sessionId);
    }
  }

  const taskListCalls = countColonyTool(calls, 'task_list');
  const taskReadyCalls = countColonyTool(calls, 'task_ready_for_agent');
  return {
    task_list_calls: taskListCalls,
    task_ready_for_agent_calls: taskReadyCalls,
    task_list_calls_without_task_ready_for_agent: taskListWithoutReady,
    sessions_with_task_list_without_task_ready_for_agent: sessionsWithTaskListWithoutReady.size,
    task_ready_share: ratio(taskReadyCalls, taskListCalls + taskReadyCalls),
  };
}

function workingNotes(calls: ToolCallRow[]): WorkingNotesBridgeMetric {
  const taskPostCalls = countColonyTool(calls, 'task_post');
  const taskNoteWorkingCalls = countColonyTool(calls, 'task_note_working');
  const colonyWorkingNoteCalls = taskPostCalls + taskNoteWorkingCalls;
  const omxNotepadWriteWorkingCalls = calls.filter((call) =>
    isOmxNotepadWriteWorking(call.tool),
  ).length;
  const status = hasOmxTelemetry(calls) ? 'available' : 'unavailable';

  return {
    status,
    omx_notepad_write_working_calls: omxNotepadWriteWorkingCalls,
    colony_working_note_calls: colonyWorkingNoteCalls,
    task_post_calls: taskPostCalls,
    task_note_working_calls: taskNoteWorkingCalls,
    colony_share:
      status === 'available'
        ? ratio(colonyWorkingNoteCalls, colonyWorkingNoteCalls + omxNotepadWriteWorkingCalls)
        : null,
  };
}

function statusReads(calls: ToolCallRow[]): StatusReadsBridgeMetric {
  const omxStateGetStatusCalls = calls.filter((call) => isOmxStateGetStatus(call.tool)).length;
  const bridgeStatusCalls = calls.filter((call) => isBridgeStatus(call.tool)).length;
  const hivemindContextCalls = countColonyTool(calls, 'hivemind_context');
  const colonyStatusReadCalls = bridgeStatusCalls + hivemindContextCalls;
  const status = hasOmxTelemetry(calls) ? 'available' : 'unavailable';

  return {
    status,
    omx_state_get_status_calls: omxStateGetStatusCalls,
    bridge_status_calls: bridgeStatusCalls,
    hivemind_context_calls: hivemindContextCalls,
    colony_status_read_calls: colonyStatusReadCalls,
    colony_share:
      status === 'available'
        ? ratio(colonyStatusReadCalls, colonyStatusReadCalls + omxStateGetStatusCalls)
        : null,
  };
}

function callsBySession(calls: ToolCallRow[]): Map<string, ToolCallRow[]> {
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const bucket = bySession.get(call.session_id) ?? [];
    bucket.push(call);
    bySession.set(call.session_id, bucket);
  }
  for (const sessionCalls of bySession.values()) {
    sessionCalls.sort((a, b) => a.ts - b.ts || a.id - b.id);
  }
  return bySession;
}

function countColonyTool(calls: ToolCallRow[], toolName: string): number {
  return calls.filter((call) => isColonyTool(call.tool, toolName)).length;
}

function isColonyTool(tool: string, toolName: string): boolean {
  return tool === toolName || tool === `colony.${toolName}` || tool === `mcp__colony__${toolName}`;
}

function isOmxNotepadWriteWorking(tool: string): boolean {
  return (
    tool === 'omx_notepad_write_working' ||
    tool === 'notepad_write_working' ||
    tool === 'mcp__omx_memory__notepad_write_working'
  );
}

function isOmxStateGetStatus(tool: string): boolean {
  return (
    tool === 'omx_state_get_status' ||
    tool === 'state_get_status' ||
    tool === 'mcp__omx_state__state_get_status' ||
    tool === 'mcp__omx_state__omx_state_get_status'
  );
}

function isBridgeStatus(tool: string): boolean {
  return (
    tool === 'bridge_status' ||
    tool === 'colony.bridge_status' ||
    tool === 'mcp__colony__bridge_status'
  );
}

function hasOmxTelemetry(calls: ToolCallRow[]): boolean {
  return calls.some(
    (call) =>
      call.tool.startsWith('mcp__omx_') ||
      call.tool.startsWith('omx_') ||
      call.tool.includes('notepad_write_working') ||
      call.tool.includes('state_get_status'),
  );
}

function conversionKey(fromTool: string, toTool: string): BridgeConversionName {
  return `${fromTool}_to_${toTool}` as BridgeConversionName;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
