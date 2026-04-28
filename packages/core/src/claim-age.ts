import { defaultSettings } from '@colony/config';

export type ClaimAgeClass = 'fresh' | 'stale' | 'expired/weak';
export type ClaimOwnershipStrength = 'strong' | 'weak';

export interface ClaimAgeClassification {
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
  stale_after_minutes: number;
  expired_after_minutes: number;
}

export interface ClaimAgeOptions {
  now?: number;
  claim_stale_minutes?: number;
}

const MINUTE_MS = 60_000;

export function classifyClaimAge(
  claimedAt: number,
  options: ClaimAgeOptions = {},
): ClaimAgeClassification {
  const now = options.now ?? Date.now();
  const staleAfterMinutes = normalizeMinutes(
    options.claim_stale_minutes,
    defaultSettings.claimStaleMinutes,
  );
  const expiredAfterMinutes = staleAfterMinutes * 2;
  const ageMinutes = Math.max(0, Math.floor((now - claimedAt) / MINUTE_MS));

  if (ageMinutes < staleAfterMinutes) {
    return {
      age_minutes: ageMinutes,
      age_class: 'fresh',
      ownership_strength: 'strong',
      stale_after_minutes: staleAfterMinutes,
      expired_after_minutes: expiredAfterMinutes,
    };
  }

  return {
    age_minutes: ageMinutes,
    age_class: ageMinutes < expiredAfterMinutes ? 'stale' : 'expired/weak',
    ownership_strength: 'weak',
    stale_after_minutes: staleAfterMinutes,
    expired_after_minutes: expiredAfterMinutes,
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
