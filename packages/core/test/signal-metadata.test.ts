import { describe, expect, it } from 'vitest';
import {
  compactSignalMetadata,
  currentSignalStrength,
  normalizeSignalMetadata,
  signalMetadataFromObservation,
  signalMetadataFromProposal,
  withSignalMetadata,
} from '../src/signal-metadata.js';

describe('signal metadata normalization', () => {
  it('normalizes compact nested signal metadata', () => {
    const signal = normalizeSignalMetadata({
      kind: 'message',
      signal: {
        signal_kind: 'message',
        strength: 0.7,
        created_at: 1_000,
        last_reinforced_at: 2_000,
        expires_at: 3_000,
        half_life_minutes: 30,
        source_session_id: 'A',
        source_agent: 'codex',
        reinforced_by_sessions: ['A', 'A', 'B'],
      },
    });

    expect(signal).toEqual({
      signal_kind: 'message',
      strength: 0.7,
      created_at: 1_000,
      last_reinforced_at: 2_000,
      expires_at: 3_000,
      half_life_minutes: 30,
      source_session_id: 'A',
      source_agent: 'codex',
      reinforced_by_sessions: ['A', 'B'],
    });
  });

  it('tolerates legacy claim observation metadata', () => {
    const signal = signalMetadataFromObservation({
      kind: 'claim',
      metadata: JSON.stringify({ kind: 'claim', file_path: 'src/auth.ts' }),
      ts: 10_000,
      session_id: 'session-A',
    });

    expect(signal).toMatchObject({
      signal_kind: 'claim',
      strength: 1,
      created_at: 10_000,
      last_reinforced_at: 10_000,
      expires_at: null,
      half_life_minutes: null,
      source_session_id: 'session-A',
      source_agent: null,
      reinforced_by_sessions: [],
    });
  });

  it('infers legacy handoff ttl and source fields', () => {
    const signal = signalMetadataFromObservation({
      kind: 'handoff',
      metadata: {
        kind: 'handoff',
        from_session_id: 'session-A',
        from_agent: 'claude',
        status: 'pending',
        expires_at: 90_000,
      },
      ts: 30_000,
      session_id: 'session-A',
    });

    expect(signal).toMatchObject({
      signal_kind: 'handoff',
      created_at: 30_000,
      expires_at: 90_000,
      source_session_id: 'session-A',
      source_agent: 'claude',
    });
  });

  it('normalizes legacy message metadata with missing ttl fields', () => {
    const signal = signalMetadataFromObservation({
      kind: 'message',
      metadata: {
        kind: 'message',
        from_session_id: 'session-A',
        from_agent: 'codex',
        urgency: 'needs_reply',
        status: 'unread',
      },
      ts: 40_000,
      session_id: 'session-A',
    });

    expect(signal).toMatchObject({
      signal_kind: 'message',
      created_at: 40_000,
      expires_at: null,
      source_session_id: 'session-A',
      source_agent: 'codex',
    });
  });

  it('normalizes plan subtask lifecycle rows', () => {
    const signal = signalMetadataFromObservation({
      kind: 'plan-subtask-claim',
      metadata: {
        kind: 'plan-subtask-claim',
        status: 'claimed',
        session_id: 'session-B',
        agent: 'codex',
      },
      ts: 50_000,
      session_id: 'session-B',
    });

    expect(signal).toMatchObject({
      signal_kind: 'plan-subtask-claim',
      created_at: 50_000,
      source_session_id: 'session-B',
      source_agent: 'codex',
    });
  });

  it('builds proposal signal metadata from reinforcement rows', () => {
    const signal = signalMetadataFromProposal(
      { proposed_by: 'session-A', proposed_at: 1_000 },
      {
        reinforcements: [
          { session_id: 'session-A', weight: 1, reinforced_at: 1_000 },
          { session_id: 'session-B', weight: 1, reinforced_at: 61_000 },
        ],
        half_life_minutes: 1,
      },
    );

    expect(signal).toMatchObject({
      signal_kind: 'proposal',
      created_at: 1_000,
      last_reinforced_at: 61_000,
      half_life_minutes: 1,
      source_session_id: 'session-A',
      reinforced_by_sessions: ['session-A', 'session-B'],
    });
    expect(signal.strength).toBeCloseTo(1.5, 5);
    expect(currentSignalStrength(signal, 121_000)).toBeCloseTo(0.75, 5);
  });

  it('serializes compactly while retaining parseable shape', () => {
    const full = signalMetadataFromObservation({
      kind: 'message',
      metadata: null,
      ts: 10,
      session_id: 'A',
    });
    if (!full) throw new Error('expected signal');

    const metadata = withSignalMetadata({ kind: 'message' }, full);
    expect(metadata).toEqual({
      kind: 'message',
      signal: {
        signal_kind: 'message',
        strength: 1,
        created_at: 10,
        source_session_id: 'A',
      },
    });

    expect(normalizeSignalMetadata(metadata)).toEqual(full);
    expect(compactSignalMetadata(full)).toEqual(metadata.signal);
  });

  it('returns zero strength after ttl expiry', () => {
    const signal = normalizeSignalMetadata({
      signal_kind: 'handoff',
      strength: 1,
      created_at: 1_000,
      expires_at: 2_000,
    });
    if (!signal) throw new Error('expected signal');

    expect(currentSignalStrength(signal, 2_000)).toBe(0);
  });
});
