import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SpawnOptions {
  cwd?: string;
  stdio: 'inherit';
  env: NodeJS.ProcessEnv;
}

interface SpawnResult {
  status: number | null;
  error?: Error;
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => SpawnResult;

export interface AutoBuildOptions {
  packageRoot?: string;
  repoRoot?: string;
  distEntry?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  exit?: (code: number) => never;
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const DIST_ENTRY = join(PACKAGE_ROOT, 'dist/index.js');

export function newestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const childMtime = entry.isDirectory() ? newestMtimeMs(child) : statSync(child).mtimeMs;
    if (childMtime > newest) newest = childMtime;
  }
  return newest;
}

export function collectSourceRoots(packageRoot = PACKAGE_ROOT, repoRoot = REPO_ROOT): string[] {
  const roots = [
    join(packageRoot, 'src'),
    join(packageRoot, 'package.json'),
    join(packageRoot, 'tsup.config.ts'),
    join(repoRoot, 'apps/mcp-server/src'),
    join(repoRoot, 'apps/worker/src'),
  ];
  const packagesRoot = join(repoRoot, 'packages');

  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = join(packagesRoot, entry.name);
      roots.push(join(packageDir, 'src'));
      roots.push(join(packageDir, 'package.json'));
      roots.push(join(packageDir, 'tsup.config.ts'));
    }
  }

  return roots;
}

export function shouldAutoBuild({
  distEntry = DIST_ENTRY,
  sourceRoots = collectSourceRoots(),
}: {
  distEntry?: string;
  sourceRoots?: string[];
} = {}): boolean {
  if (!existsSync(distEntry)) return true;
  const distMtime = statSync(distEntry).mtimeMs;
  return sourceRoots.some((sourceRoot) => newestMtimeMs(sourceRoot) > distMtime);
}

export function isSourceCheckout(packageRoot = PACKAGE_ROOT, repoRoot = REPO_ROOT): boolean {
  return existsSync(join(packageRoot, 'src')) && existsSync(join(repoRoot, 'pnpm-workspace.yaml'));
}

export function maybeReexecAfterAutoBuild({
  packageRoot = PACKAGE_ROOT,
  repoRoot = REPO_ROOT,
  distEntry = DIST_ENTRY,
  argv = process.argv,
  env = process.env,
  spawn = spawnSync,
  stderr = process.stderr,
  exit = process.exit,
}: AutoBuildOptions = {}): { ran: boolean; reason: string; status?: number } {
  if (env.COLONY_SKIP_AUTO_BUILD === '1' || env.COLONY_SKIP_AUTO_BUILD === 'true') {
    return { ran: false, reason: 'disabled' };
  }
  if (!isSourceCheckout(packageRoot, repoRoot))
    return { ran: false, reason: 'not_source_checkout' };

  const sourceRoots = collectSourceRoots(packageRoot, repoRoot);
  if (!shouldAutoBuild({ distEntry, sourceRoots })) return { ran: false, reason: 'fresh' };

  stderr.write('colony: local sources changed; rebuilding CLI dist...\n');
  const build = spawn('pnpm', ['--filter', '@imdeadpool/colony-cli', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...env, COLONY_SKIP_AUTO_BUILD: '1' },
  });

  if (build.error) throw build.error;
  if (build.status !== 0) {
    const status = build.status ?? 1;
    if (!existsSync(distEntry)) exit(status);
    stderr.write(`colony: auto-build failed with status ${status}; using existing dist.\n`);
    return { ran: true, status, reason: 'failed_using_existing_dist' };
  }

  const rerun = spawn(process.execPath, argv.slice(1), {
    stdio: 'inherit',
    env: { ...env, COLONY_SKIP_AUTO_BUILD: '1' },
  });
  if (rerun.error) throw rerun.error;
  exit(rerun.status ?? 1);
  return { ran: true, status: rerun.status ?? 1, reason: 'reran' };
}
