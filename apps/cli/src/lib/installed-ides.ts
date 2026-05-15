import type { Settings } from '@colony/config';

/**
 * Names of IDEs that the user has flagged as installed in their settings.
 *
 * Both `status` and `health --coach` need this list, so it lives in a
 * shared lib helper to avoid drift between the two surfaces. The order
 * follows the insertion order of `settings.ides`, which keeps the output
 * stable across runs.
 */
export function listInstalledIdes(settings: Settings): string[] {
  return Object.entries(settings.ides)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}
