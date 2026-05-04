import { describe, expect, it } from 'vitest';
import {
  RUFLO_BRIDGE_EVENT_FAMILIES,
  RUFLO_BRIDGE_EVENT_FAMILY_BY_NAME,
  RUFLO_BRIDGE_EVENT_NAMES,
  type RufloBridgeEvent,
  mapRufloEventToColonyObservation,
} from '../src/index.js';

describe('Ruflo bridge schema', () => {
  it('declares the core event families and deterministic event-name mapping', () => {
    expect(RUFLO_BRIDGE_EVENT_FAMILIES).toEqual([
      'agent',
      'swarm',
      'tasks',
      'memory',
      'hooks',
      'federation',
      'tools',
    ]);
    expect(RUFLO_BRIDGE_EVENT_NAMES).toEqual([
      'agent/start',
      'agent/finish',
      'agent/error',
      'swarm/task-assigned',
      'swarm/task-completed',
      'tasks/created',
      'tasks/blocked',
      'memory/write',
      'memory/search',
      'hooks/pre',
      'hooks/post',
      'federation/handoff',
      'tools/call',
      'tools/result',
    ]);
    expect(RUFLO_BRIDGE_EVENT_FAMILY_BY_NAME).toMatchObject({
      'agent/start': 'agent',
      'agent/finish': 'agent',
      'agent/error': 'agent',
      'swarm/task-assigned': 'swarm',
      'swarm/task-completed': 'swarm',
      'tasks/created': 'tasks',
      'tasks/blocked': 'tasks',
      'memory/write': 'memory',
      'memory/search': 'memory',
      'hooks/pre': 'hooks',
      'hooks/post': 'hooks',
      'federation/handoff': 'federation',
      'tools/call': 'tools',
      'tools/result': 'tools',
    });
  });

  it('maps a Ruflo event to compact Colony observation content and metadata', () => {
    const event: RufloBridgeEvent<'swarm/task-completed'> = {
      name: 'swarm/task-completed',
      run_id: 'run-123',
      agent_id: 'agent-7',
      task_id: 42,
      repo_root: '/repo',
      success: true,
      duration_ms: 1250,
      summary: 'completed task from Ruflo swarm',
    };

    expect(mapRufloEventToColonyObservation(event)).toEqual({
      kind: 'ruflo-bridge',
      task_id: 42,
      content:
        'ruflo bridge: event=swarm/task-completed; run=run-123; agent=agent-7; task=42; repo=/repo; success=true; duration_ms=1250; summary=completed task from Ruflo swarm',
      metadata: {
        ruflo_event_family: 'swarm',
        ruflo_event_name: 'swarm/task-completed',
        ruflo_run_id: 'run-123',
        ruflo_agent_id: 'agent-7',
        task_id: 42,
        repo_root: '/repo',
        success: true,
        duration_ms: 1250,
      },
    });
  });

  it('preserves false success and string task ids without forcing Colony task linkage', () => {
    const observation = mapRufloEventToColonyObservation({
      name: 'agent/error',
      run_id: 'run-err',
      agent_id: 'agent-err',
      task_id: 'ruflo-task-1',
      success: false,
      summary: 'agent failed',
    });

    expect(observation).not.toHaveProperty('task_id');
    expect(observation.metadata).toMatchObject({
      ruflo_event_family: 'agent',
      ruflo_event_name: 'agent/error',
      ruflo_run_id: 'run-err',
      ruflo_agent_id: 'agent-err',
      task_id: 'ruflo-task-1',
      success: false,
    });
    expect(observation.content).toContain('success=false');
  });

  it('does not copy full payload or body data into the observation by default', () => {
    const observation = mapRufloEventToColonyObservation({
      name: 'tools/result',
      run_id: 'run-tool',
      payload: { stdout: 'x'.repeat(1_000) },
      body: { stderr: 'y'.repeat(1_000) },
      summary: 'tool returned',
    });

    expect(observation.content.length).toBeLessThan(700);
    expect(observation.content).not.toContain('stdout');
    expect(observation.content).not.toContain('stderr');
    expect(observation.metadata).toEqual({
      ruflo_event_family: 'tools',
      ruflo_event_name: 'tools/result',
      ruflo_run_id: 'run-tool',
    });
  });
});
