export interface BuildTokenReceiptInput {
  surface: string;
  tokensBefore: number;
  tokensAfter: number;
  itemsAvailable?: number;
  itemsReturned?: number;
  collapsedCount?: number;
  policy?: string;
  reason?: string;
}

export interface TokenReceiptMetadata {
  kind: 'token_receipt';
  surface: string;
  tokens_before: number;
  tokens_after: number;
  saved_tokens: number;
  saved_ratio: number;
  items_available: number | null;
  items_returned: number | null;
  collapsed_count: number;
  policy: string | null;
  reason: string;
}

export interface TokenReceipt {
  content: string;
  metadata: TokenReceiptMetadata;
}

const DEFAULT_SURFACE = 'unknown';
const DEFAULT_REASON = 'unspecified';
const MAX_LABEL_LENGTH = 120;

export function buildTokenReceipt(input: BuildTokenReceiptInput): TokenReceipt {
  const surface = normalizeLabel(input.surface, DEFAULT_SURFACE);
  const tokensBefore = normalizeCount(input.tokensBefore);
  const tokensAfter = normalizeCount(input.tokensAfter);
  const savedTokens = Math.max(0, tokensBefore - tokensAfter);
  const reason = normalizeLabel(input.reason, DEFAULT_REASON);

  const metadata: TokenReceiptMetadata = {
    kind: 'token_receipt',
    surface,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    saved_tokens: savedTokens,
    saved_ratio: tokensBefore > 0 ? savedTokens / tokensBefore : 0,
    items_available: normalizeOptionalCount(input.itemsAvailable),
    items_returned: normalizeOptionalCount(input.itemsReturned),
    collapsed_count: normalizeCount(input.collapsedCount),
    policy: normalizeOptionalLabel(input.policy),
    reason,
  };

  return {
    content: `token receipt: surface=${surface} before=${tokensBefore} after=${tokensAfter} saved=${savedTokens} reason=${reason}`,
    metadata,
  };
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return normalizeCount(value);
}

function normalizeOptionalLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const label = normalizeLabel(value, '');
  return label || null;
}

function normalizeLabel(value: unknown, fallback: string): string {
  const compact =
    typeof value === 'string' ? redactSensitiveFragments(value).replace(/\s+/g, ' ').trim() : '';
  return (compact || fallback).slice(0, MAX_LABEL_LENGTH);
}

function redactSensitiveFragments(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[redacted]');
}
