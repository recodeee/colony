import { type SpawnOptions, spawn } from 'node:child_process';

/**
 * Spawn a Node script with `process.execPath` so the OS does not have to
 * figure out how to exec a `.js` file. Windows cannot exec `.js` directly
 * (EFTYPE); macOS and Linux tolerate it only when the shebang resolves to a
 * real node binary. Using `execPath` avoids both failure modes.
 *
 * Defaults to a fully detached child: `detached: true`, `stdio: 'ignore'`,
 * and `child.unref()`. Callers can override any of those via `opts`.
 */
export function spawnNodeScript(
  script: string,
  args: readonly string[] = [],
  opts: SpawnOptions = {},
): ReturnType<typeof spawn> {
  const merged: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    ...opts,
  };
  const child = spawn(process.execPath, [script, ...args], merged);
  if (merged.detached) child.unref();
  return child;
}
