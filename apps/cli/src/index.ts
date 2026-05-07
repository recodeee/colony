#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, type ParseOptions } from 'commander';
import { maybeReexecAfterAutoBuild } from './auto-build.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerBackfillCommand } from './commands/backfill.js';
import { registerBridgeCommand } from './commands/bridge.js';
import { registerClaimsCommand } from './commands/claims.js';
import { registerCockpitCommand } from './commands/cockpit.js';
import { registerCocoIndexCommand } from './commands/cocoindex.js';
import { registerCompressCommands } from './commands/compress.js';
import { registerConfigCommand } from './commands/config.js';
import { registerCoordinationCommand } from './commands/coordination.js';
import { registerDebriefCommand } from './commands/debrief.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExportCommand } from './commands/export.js';
import { registerForagingCommand } from './commands/foraging.js';
import { registerGainCommand } from './commands/gain.js';
import { registerHealCommand } from './commands/heal.js';
import { registerHealthCommand } from './commands/health.js';
import { registerHookCommand } from './commands/hook.js';
import { registerInboxCommand } from './commands/inbox.js';
import { registerInstallCommand } from './commands/install.js';
import { registerLaneCommand } from './commands/lane.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerNoteCommand } from './commands/note.js';
import { registerObserveCommand } from './commands/observe.js';
import { registerOpenSpecCommand } from './commands/openspec.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerPlansCommand } from './commands/plans.js';
import { registerQueenCommand } from './commands/queen.js';
import { registerReindexCommand } from './commands/reindex.js';
import { registerRescueCommand } from './commands/rescue.js';
import { registerResumeCommand } from './commands/resume.js';
import { registerSearchCommand } from './commands/search.js';
import { registerSidecarCommand } from './commands/sidecar.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSuggestCommand } from './commands/suggest.js';
import { registerTaskCommand } from './commands/task.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerWorkerCommand } from './commands/worker.js';
import { registerWorktreeCommand } from './commands/worktree.js';

export function createProgram(): Command {
  const program = new Command();

  // Commander's .version() flag spec only accepts one short + one long flag.
  // The original `-v, -V, --version` triple silently dropped the trailing
  // entries, so plain `colony --version` was rejected as an unknown option
  // (caught by scripts/e2e-publish.sh check #6). Register the canonical
  // `-V, --version` pair here; the lowercase `-v` alias is canonicalized
  // to `-V` in argv before parse.
  program
    .name('colony')
    .description('Cross-agent persistent memory with compressed storage.')
    .version(__COLONY_VERSION__, '-V, --version');

  registerAgentsCommand(program);
  registerCockpitCommand(program);
  registerCocoIndexCommand(program);
  registerClaimsCommand(program);
  registerInstallCommand(program);
  registerLaneCommand(program);
  registerUninstallCommand(program);
  registerStatusCommand(program);
  registerHealthCommand(program);
  registerHealCommand(program);
  registerConfigCommand(program);
  registerDoctorCommand(program);
  registerLifecycleCommands(program);
  registerWorkerCommand(program);
  registerWorktreeCommand(program);
  registerMcpCommand(program);
  registerBridgeCommand(program);
  registerSearchCommand(program);
  registerSidecarCommand(program);
  registerSuggestCommand(program);
  registerTaskCommand(program);
  registerCompressCommands(program);
  registerCoordinationCommand(program);
  registerExportCommand(program);
  registerHookCommand(program);
  registerReindexCommand(program);
  registerBackfillCommand(program);
  registerNoteCommand(program);
  registerObserveCommand(program);
  registerOpenSpecCommand(program);
  registerPlanCommand(program);
  registerPlansCommand(program);
  registerDebriefCommand(program);
  registerInboxCommand(program);
  registerForagingCommand(program);
  registerGainCommand(program);
  registerQueenCommand(program);
  registerResumeCommand(program);
  registerRescueCommand(program);

  // Canonicalize the lowercase `-v` shorthand to `-V` inside parseAsync so
  // commander's two-flag `.version()` registration handles it from every
  // entry path — bin shim, tests calling parseAsync directly, embedded
  // callers that build the program. (Pre-PR-#444, the for-loop in the
  // bin-entry block missed test-driven parseAsync calls.)
  const originalParseAsync = program.parseAsync.bind(program);
  program.parseAsync = ((argv?: readonly string[], options?: ParseOptions) => {
    const adjusted = argv?.map((arg) => (arg === '-v' ? '-V' : arg));
    return originalParseAsync(adjusted, options);
  }) as Command['parseAsync'];

  return program;
}

if (isMainEntry()) {
  maybeReexecAfterAutoBuild();
  // When stdout is piped to a consumer that exits early (e.g. `| head`, `| grep -q`),
  // further writes raise EPIPE. Node turns that into an uncaught exception by default,
  // which is noisy and misleading for what is really a successful upstream-terminated pipe.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  createProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      process.stderr.write(`colony error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

/**
 * Detects whether this module is the process entrypoint. The naive
 * `import.meta.url === file://${process.argv[1]}` check is wrong when the
 * binary is invoked through an npm-installed symlink, because argv[1] is the
 * symlink path while import.meta.url resolves to the real file.
 */
function isMainEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}
