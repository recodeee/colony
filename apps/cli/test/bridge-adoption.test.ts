import { describe, expect, it } from 'vitest';
import { buildBridgeAdoptionMetrics } from '../src/bridge-adoption.js';

function call(id: number, sessionId: string, tool: string, ts: number) {
  return { id, session_id: sessionId, tool, ts };
}

describe('buildBridgeAdoptionMetrics', () => {
  it('calculates bridge loop conversions and OMX fallback replacement ratios', () => {
    const metrics = buildBridgeAdoptionMetrics([
      call(1, 'codex-a', 'mcp__colony__hivemind_context', 1_000),
      call(2, 'codex-a', 'mcp__colony__attention_inbox', 2_000),
      call(3, 'codex-a', 'mcp__colony__task_list', 3_000),
      call(4, 'codex-a', 'mcp__colony__task_ready_for_agent', 4_000),
      call(5, 'codex-a', 'mcp__colony__task_post', 5_000),
      call(6, 'codex-a', 'mcp__colony__task_note_working', 6_000),
      call(7, 'codex-a', 'mcp__colony__bridge_status', 7_000),
      call(8, 'codex-a', 'mcp__omx_memory__notepad_write_working', 8_000),
      call(9, 'codex-a', 'mcp__omx_state__state_get_status', 9_000),
      call(10, 'codex-b', 'mcp__colony__hivemind_context', 1_500),
      call(11, 'codex-b', 'mcp__colony__task_list', 2_500),
    ]);

    expect(metrics.conversions.hivemind_context_to_attention_inbox).toMatchObject({
      from_calls: 2,
      to_calls: 1,
      from_sessions: 2,
      converted_sessions: 1,
      conversion_rate: 1 / 2,
    });
    expect(metrics.conversions.attention_inbox_to_task_ready_for_agent).toMatchObject({
      from_calls: 1,
      to_calls: 1,
      from_sessions: 1,
      converted_sessions: 1,
      conversion_rate: 1,
    });
    expect(metrics.task_list_without_task_ready_for_agent).toMatchObject({
      task_list_calls: 2,
      task_ready_for_agent_calls: 1,
      task_list_calls_without_task_ready_for_agent: 1,
      sessions_with_task_list_without_task_ready_for_agent: 1,
      task_ready_share: 1 / 3,
    });
    expect(metrics.working_notes).toMatchObject({
      status: 'available',
      omx_notepad_write_working_calls: 1,
      colony_working_note_calls: 2,
      task_post_calls: 1,
      task_note_working_calls: 1,
      colony_share: 2 / 3,
    });
    expect(metrics.status_reads).toMatchObject({
      status: 'available',
      omx_state_get_status_calls: 1,
      bridge_status_calls: 1,
      hivemind_context_calls: 2,
      colony_status_read_calls: 3,
      colony_share: 3 / 4,
    });
  });

  it('reports OMX ratios as unavailable when local telemetry has no OMX tool calls', () => {
    const metrics = buildBridgeAdoptionMetrics([
      call(1, 'codex-a', 'mcp__colony__hivemind_context', 1_000),
      call(2, 'codex-a', 'mcp__colony__task_post', 2_000),
    ]);

    expect(metrics.working_notes).toMatchObject({
      status: 'unavailable',
      omx_notepad_write_working_calls: 0,
      colony_working_note_calls: 1,
      colony_share: null,
    });
    expect(metrics.status_reads).toMatchObject({
      status: 'unavailable',
      omx_state_get_status_calls: 0,
      bridge_status_calls: 0,
      hivemind_context_calls: 1,
      colony_share: null,
    });
  });
});
