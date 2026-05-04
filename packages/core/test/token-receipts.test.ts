import { type TokenReceipt, buildTokenReceipt } from '@colony/core';
import { describe, expect, it } from 'vitest';

describe('token receipt builder', () => {
  it('builds deterministic compact token receipt metadata and content', () => {
    const receipt: TokenReceipt = buildTokenReceipt({
      surface: 'SessionStart',
      tokensBefore: 1000,
      tokensAfter: 625,
      itemsAvailable: 20,
      itemsReturned: 3,
      collapsedCount: 17,
      policy: 'attention-budget-v1',
      reason: 'collapsed noisy attention',
    });

    expect(receipt).toEqual({
      content:
        'token receipt: surface=SessionStart before=1000 after=625 saved=375 reason=collapsed noisy attention',
      metadata: {
        kind: 'token_receipt',
        surface: 'SessionStart',
        tokens_before: 1000,
        tokens_after: 625,
        saved_tokens: 375,
        saved_ratio: 0.375,
        items_available: 20,
        items_returned: 3,
        collapsed_count: 17,
        policy: 'attention-budget-v1',
        reason: 'collapsed noisy attention',
      },
    });
  });

  it('never reports negative savings and handles zero before count', () => {
    expect(
      buildTokenReceipt({
        surface: 'attention_inbox',
        tokensBefore: 0,
        tokensAfter: 50,
        reason: 'expanded',
      }).metadata,
    ).toMatchObject({
      tokens_before: 0,
      tokens_after: 50,
      saved_tokens: 0,
      saved_ratio: 0,
    });

    expect(
      buildTokenReceipt({
        surface: 'attention_inbox',
        tokensBefore: 50,
        tokensAfter: 80,
        reason: 'expanded',
      }).metadata,
    ).toMatchObject({
      saved_tokens: 0,
      saved_ratio: 0,
    });
  });

  it('normalizes invalid numbers conservatively', () => {
    const receipt = buildTokenReceipt({
      surface: 'budget',
      tokensBefore: Number.POSITIVE_INFINITY,
      tokensAfter: -12.9,
      itemsAvailable: Number.NaN,
      itemsReturned: 2.9,
      collapsedCount: -5,
      reason: 'numbers normalized',
    });

    expect(receipt.metadata).toMatchObject({
      tokens_before: 0,
      tokens_after: 0,
      saved_tokens: 0,
      saved_ratio: 0,
      items_available: 0,
      items_returned: 2,
      collapsed_count: 0,
    });
    expect(receipt.content).toBe(
      'token receipt: surface=budget before=0 after=0 saved=0 reason=numbers normalized',
    );
  });

  it('does not preserve obvious secret-shaped strings in compact labels', () => {
    const receipt = buildTokenReceipt({
      surface: 'hook',
      tokensBefore: 10,
      tokensAfter: 1,
      policy: 'policy sk-proj_SECRET123456789',
      reason: 'trim ghp_secretTOKEN123456789',
    });

    expect(receipt.metadata.policy).toBe('policy [redacted]');
    expect(receipt.metadata.reason).toBe('trim [redacted]');
    expect(receipt.content).not.toContain('sk-proj_SECRET123456789');
    expect(receipt.content).not.toContain('ghp_secretTOKEN123456789');
  });
});
