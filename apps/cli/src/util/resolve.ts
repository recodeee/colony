import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Absolute path to the colony CLI binary. The installer writes this into
 * IDE config files, so it must resolve correctly in both dev and installed modes.
 *
 * When a global `colony install --ide codex` is launched from inside a Colony
 * source checkout, prefer the checkout's dist entry. That lets MCP/Codex pick
 * up local changes through the CLI auto-build path instead of waiting for a
 * fresh global npm publish/install.
 */
export function resolveCliPath({
  argv1 = process.argv[1],
  cwd = process.cwd(),
}: {
  argv1?: string;
  cwd?: string;
} = {}): string {
  const localCheckoutCli = resolveLocalCheckoutCliPath(cwd);
  if (localCheckoutCli) return localCheckoutCli;

  if (!argv1) return 'colony';
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

export function resolveLocalCheckoutCliPath(cwd = process.cwd()): string | null {
  let current = resolve(cwd);

  while (true) {
    const cliDist = join(current, 'apps', 'cli', 'dist', 'index.js');
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'apps', 'cli', 'package.json')) &&
      existsSync(cliDist)
    ) {
      return realpathSync(cliDist);
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
