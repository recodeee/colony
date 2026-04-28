import type { MemoryStore } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

interface RescueStrandedOptions {
  dry_run: boolean;
  stranded_after_ms?: number;
}

interface RescueStrandedOutcome {
  dry_run: boolean;
  stranded: Array<Record<string, unknown>>;
  rescued: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

type RescueStrandedSessionsFn = (
  store: MemoryStore,
  options: RescueStrandedOptions,
) => RescueStrandedOutcome | Promise<RescueStrandedOutcome>;

export function register(
  server: McpServer,
  ctx: ToolContext,
  opts: { rescueStrandedSessions?: RescueStrandedSessionsFn } = {},
): void {
  const { store } = ctx;

  server.tool(
    'rescue_stranded_scan',
    'Find stranded sessions or abandoned file claims without changing state. Dry-run scan for stuck work before running a rescue.',
    {
      stranded_after_minutes: z.number().positive().optional(),
    },
    async (args) => {
      const outcome = await runRescue(store, opts.rescueStrandedSessions, {
        dry_run: true,
        ...(args.stranded_after_minutes !== undefined
          ? { stranded_after_ms: args.stranded_after_minutes * 60_000 }
          : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    },
  );

  server.tool(
    'rescue_stranded_run',
    'Rescue stranded sessions and emit relays after confirmation. Requires confirm: true because this drops stranded file claims.',
    {
      stranded_after_minutes: z.number().positive().optional(),
      confirm: z.boolean().optional(),
    },
    async (args) => {
      if (args.confirm !== true) {
        return rescueError('RESCUE_CONFIRM_REQUIRED', 'rescue_stranded_run requires confirm: true');
      }
      const outcome = await runRescue(store, opts.rescueStrandedSessions, {
        dry_run: false,
        ...(args.stranded_after_minutes !== undefined
          ? { stranded_after_ms: args.stranded_after_minutes * 60_000 }
          : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    },
  );
}

function rescueError(
  code: 'RESCUE_CONFIRM_REQUIRED',
  error: string,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code, error }) }],
    isError: true,
  };
}

async function runRescue(
  store: MemoryStore,
  injected: RescueStrandedSessionsFn | undefined,
  options: RescueStrandedOptions,
): Promise<RescueStrandedOutcome> {
  const rescue = injected ?? (await loadRescueStrandedSessions());
  const outcome = await runRescueWithDryRunRollback(store, rescue, options);
  const rescued = Array.isArray(outcome.rescued) ? outcome.rescued : [];
  return {
    ...outcome,
    dry_run: typeof outcome.dry_run === 'boolean' ? outcome.dry_run : options.dry_run,
    stranded: Array.isArray(outcome.stranded) ? outcome.stranded : rescued,
    rescued,
  };
}

async function runRescueWithDryRunRollback(
  store: MemoryStore,
  rescue: RescueStrandedSessionsFn,
  options: RescueStrandedOptions,
): Promise<RescueStrandedOutcome> {
  if (!options.dry_run) return rescue(store, options);
  return rollbackDryRun(store, () => rescue(store, options));
}

function rollbackDryRun(
  store: MemoryStore,
  fn: () => RescueStrandedOutcome | Promise<RescueStrandedOutcome>,
): RescueStrandedOutcome {
  const rollback = new Error('rollback dry-run rescue scan');
  let outcome: RescueStrandedOutcome | Promise<RescueStrandedOutcome> | undefined;
  try {
    store.storage.transaction(() => {
      outcome = fn();
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  if (!outcome || outcome instanceof Promise) {
    throw new Error('dry-run rescue scan must complete synchronously');
  }
  return outcome;
}

async function loadRescueStrandedSessions(): Promise<RescueStrandedSessionsFn> {
  const mod = (await import('@colony/core')) as Record<string, unknown>;
  const rescue = mod.rescueStrandedSessions;
  if (typeof rescue !== 'function') {
    throw new Error('rescueStrandedSessions is unavailable; merge the core substrate first');
  }
  return rescue as RescueStrandedSessionsFn;
}
