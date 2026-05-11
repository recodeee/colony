import type { MemoryStore } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { mcpErrorResponse } from './shared.js';

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
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'rescue_stranded_scan',
    'Find stranded sessions or abandoned file claims without changes. Dry-run scan surfaces stale claims, stuck work, and rescue candidates before mutation.',
    {
      stranded_after_minutes: z.number().positive().optional(),
    },
    wrapHandler('rescue_stranded_scan', async (args) => {
      const outcome = await runRescue(store, opts.rescueStrandedSessions, {
        dry_run: true,
        ...(args.stranded_after_minutes !== undefined
          ? { stranded_after_ms: args.stranded_after_minutes * 60_000 }
          : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    }),
  );

  server.tool(
    'rescue_stranded_run',
    'Rescue stranded sessions and emit relays after confirmation. Requires confirm: true because it drops stranded claims and creates relay handoff records.',
    {
      stranded_after_minutes: z.number().positive().optional(),
      confirm: z.boolean().optional(),
    },
    wrapHandler('rescue_stranded_run', async (args) => {
      if (args.confirm !== true) {
        return mcpErrorResponse(
          'RESCUE_CONFIRM_REQUIRED',
          'rescue_stranded_run requires confirm: true',
        );
      }
      const outcome = await runRescue(store, opts.rescueStrandedSessions, {
        dry_run: false,
        ...(args.stranded_after_minutes !== undefined
          ? { stranded_after_ms: args.stranded_after_minutes * 60_000 }
          : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    }),
  );
}

async function runRescue(
  store: MemoryStore,
  injected: RescueStrandedSessionsFn | undefined,
  options: RescueStrandedOptions,
): Promise<RescueStrandedOutcome> {
  const rescue = injected ?? (await loadRescueStrandedSessions());
  const outcome = await runRescueWithDryRunRollback(store, rescue, options);
  const stranded = Array.isArray(outcome.stranded) ? outcome.stranded : [];
  const rescued =
    Array.isArray(outcome.rescued) && outcome.rescued.length > 0
      ? outcome.rescued
      : options.dry_run
        ? stranded
        : [];
  return {
    ...outcome,
    dry_run: typeof outcome.dry_run === 'boolean' ? outcome.dry_run : options.dry_run,
    stranded: stranded.length > 0 ? stranded : rescued,
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
  const rescue = mod.bulkRescueStrandedSessions;
  if (typeof rescue !== 'function') {
    throw new Error('bulkRescueStrandedSessions is unavailable; merge the core substrate first');
  }
  return rescue as RescueStrandedSessionsFn;
}
