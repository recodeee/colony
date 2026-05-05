export const REFLEXION_OBSERVATION_KIND = 'reflexion' as const;

export type ReflexionKind = 'failure' | 'expiry' | 'rollback' | 'success';

export const REFLEXION_REWARD_BY_KIND = {
  failure: -1,
  expiry: -0.5,
  rollback: -0.25,
  success: 1,
} as const satisfies Record<ReflexionKind, number>;

interface ReflexionMetadataBase {
  task_id: number;
  attempt: number;
  /** Short caveman-friendly summary, max 120 chars. */
  action: string;
  /** What happened, max 240 chars. Stored as compressed observation content too. */
  observation_summary: string;
  /** One-line lesson, max 240 chars. Stored as compressed observation content too. */
  reflection: string;
  success: boolean;
  tags: string[];
}

export type ReflexionMetadata = {
  [K in ReflexionKind]: ReflexionMetadataBase & {
    kind: K;
    /** Deterministic from kind via REFLEXION_REWARD_BY_KIND, range -1..1. */
    reward: (typeof REFLEXION_REWARD_BY_KIND)[K];
  };
}[ReflexionKind];
