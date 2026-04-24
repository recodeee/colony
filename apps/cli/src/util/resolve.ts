import { realpathSync } from 'node:fs';

/**
 * Absolute path to the colony CLI binary. The installer writes this into
 * IDE config files, so it must resolve correctly in both dev and installed modes.
 */
export function resolveCliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) return 'colony';
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}
