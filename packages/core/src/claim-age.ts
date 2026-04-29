import { defaultSettings } from '@colony/config';

export type ClaimAgeClass = 'fresh' | 'stale' | 'expired/weak';
export type ClaimOwnershipStrength = 'strong' | 'weak';
export type ClaimLifecycleState = 'active' | 'handoff_pending';

export interface ClaimAgeInput {
  claimed_at: number;
  state?: ClaimLifecycleState;
  expires_at?: number | null;
}

export interface ClaimAgeClassification {
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
  stale_after_minutes: number;
  expired_after_minutes: number;
  state: ClaimLifecycleState;
  expires_at: number | null;
}

export interface ClaimAgeOptions {
  now?: number;
  claim_stale_minutes?: number;
}

const MINUTE_MS = 60_000;

export function classifyClaimAge(
  claimedAt: number | ClaimAgeInput,
  options: ClaimAgeOptions = {},
): ClaimAgeClassification {
  const now = options.now ?? Date.now();
  const input =
    typeof claimedAt === 'number'
      ? { claimed_at: claimedAt, state: 'active' as const, expires_at: null }
      : {
          claimed_at: claimedAt.claimed_at,
          state: claimedAt.state ?? ('active' as const),
          expires_at: claimedAt.expires_at ?? null,
        };
  const staleAfterMinutes = normalizeMinutes(
    options.claim_stale_minutes,
    defaultSettings.claimStaleMinutes,
  );
  const expiredAfterMinutes = staleAfterMinutes * 2;
  const ageMinutes = Math.max(0, Math.floor((now - input.claimed_at) / MINUTE_MS));

  if (input.state === 'handoff_pending') {
    return {
      age_minutes: ageMinutes,
      age_class:
        typeof input.expires_at === 'number' && now >= input.expires_at ? 'expired/weak' : 'stale',
      ownership_strength: 'weak',
      stale_after_minutes: staleAfterMinutes,
      expired_after_minutes: expiredAfterMinutes,
      state: input.state,
      expires_at: input.expires_at,
    };
  }

  if (ageMinutes < staleAfterMinutes) {
    return {
      age_minutes: ageMinutes,
      age_class: 'fresh',
      ownership_strength: 'strong',
      stale_after_minutes: staleAfterMinutes,
      expired_after_minutes: expiredAfterMinutes,
      state: input.state,
      expires_at: input.expires_at,
    };
  }

  return {
    age_minutes: ageMinutes,
    age_class: ageMinutes < expiredAfterMinutes ? 'stale' : 'expired/weak',
    ownership_strength: 'weak',
    stale_after_minutes: staleAfterMinutes,
    expired_after_minutes: expiredAfterMinutes,
    state: input.state,
    expires_at: input.expires_at,
  };
}

export function isStrongClaimAge(classification: {
  ownership_strength: ClaimOwnershipStrength;
}): boolean {
  return classification.ownership_strength === 'strong';
}

function normalizeMinutes(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}
