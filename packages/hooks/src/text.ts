export function truncateUtf8Safe(value: string, maxCodePoints: number, suffix = '...'): string {
  if (maxCodePoints <= 0) return '';
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) return value;
  return `${chars.slice(0, maxCodePoints).join('')}${suffix}`;
}

export function stringifyShortUtf8Safe(value: unknown, suffix = '...'): string {
  if (value == null) return '';
  if (typeof value === 'string') return truncateUtf8Safe(value, 500, suffix);
  try {
    return truncateUtf8Safe(JSON.stringify(value), 500, suffix);
  } catch {
    return truncateUtf8Safe(String(value), 500, suffix);
  }
}
