import { loadSettings } from '@colony/config';
import type { ClaimBeforeEditStats, Storage, ToolCallRow } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';

const DEFAULT_HOURS = 24;
const HEALTH_TOOL_LIMIT = 5;

const CONVERSIONS = [
  ['hivemind_context', 'attention_inbox'],
  ['task_list', 'task_ready_for_agent'],
  ['task_ready_for_agent', 'task_plan_claim_subtask'],
] as const;

type ConversionName =
  | 'hivemind_context_to_attention_inbox'
  | 'task_list_to_task_ready_for_agent'
  | 'task_ready_for_agent_to_task_plan_claim_subtask';

interface SharePayload {
  total_tool_calls: number;
  mcp_tool_calls: number;
  colony_mcp_tool_calls: number;
  share_of_all_tool_calls: number | null;
  share_of_mcp_tool_calls: number | null;
}

interface ConversionPayload {
  from_tool: string;
  to_tool: string;
  from_calls: number;
  to_calls: number;
  from_sessions: number;
  converted_sessions: number;
  conversion_rate: number | null;
}

interface TaskPostMessagePayload {
  task_post_calls: number;
  task_message_calls: number;
  task_message_share: number | null;
}

interface SearchCallsPayload {
  total_search_calls: number;
  active_sessions: number;
  average_per_active_session: number | null;
  sessions: Array<{ session_id: string; calls: number }>;
}

interface ClaimBeforeEditPayload extends ClaimBeforeEditStats {
  status: 'available' | 'not_available' | 'no_data';
  task_claim_file_calls: number;
  edits_without_claim_before: number;
  claim_before_edit_ratio: number | null;
}

export interface ColonyHealthPayload {
  generated_at: string;
  window_hours: number;
  colony_mcp_share: SharePayload;
  conversions: Record<ConversionName, ConversionPayload>;
  task_post_vs_task_message: TaskPostMessagePayload;
  search_calls_per_session: SearchCallsPayload;
  task_claim_file_before_edits: ClaimBeforeEditPayload;
}

export function buildColonyHealthPayload(
  storage: Pick<Storage, 'toolCallsSince' | 'claimBeforeEditStats'>,
  options: { since: number; window_hours: number; now?: number },
): ColonyHealthPayload {
  const calls = storage.toolCallsSince(options.since);
  const totalToolCalls = calls.length;
  const mcpToolCalls = calls.filter((call) => isMcpTool(call.tool)).length;
  const colonyMcpToolCalls = calls.filter((call) => isColonyMcpTool(call.tool)).length;
  const conversionEntries = CONVERSIONS.map(([from, to]) => [
    conversionKey(from, to),
    conversion(calls, from, to),
  ]);
  const taskPostCalls = countTool(calls, 'task_post');
  const taskMessageCalls = countTool(calls, 'task_message');
  const searchCalls = searchCallsPerSession(calls);
  const claimBeforeEditStats = storage.claimBeforeEditStats(options.since);

  return {
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    window_hours: options.window_hours,
    colony_mcp_share: {
      total_tool_calls: totalToolCalls,
      mcp_tool_calls: mcpToolCalls,
      colony_mcp_tool_calls: colonyMcpToolCalls,
      share_of_all_tool_calls: ratio(colonyMcpToolCalls, totalToolCalls),
      share_of_mcp_tool_calls: ratio(colonyMcpToolCalls, mcpToolCalls),
    },
    conversions: Object.fromEntries(conversionEntries) as Record<ConversionName, ConversionPayload>,
    task_post_vs_task_message: {
      task_post_calls: taskPostCalls,
      task_message_calls: taskMessageCalls,
      task_message_share: ratio(taskMessageCalls, taskPostCalls + taskMessageCalls),
    },
    search_calls_per_session: searchCalls,
    task_claim_file_before_edits: claimBeforeEditPayload(
      claimBeforeEditStats,
      countTool(calls, 'task_claim_file'),
    ),
  };
}

export function formatColonyHealthOutput(
  payload: ColonyHealthPayload,
  options: { json?: boolean } = {},
): string {
  if (options.json) return JSON.stringify(payload, null, 2);

  const lines = [
    kleur.bold('colony health'),
    kleur.dim(`window: last ${payload.window_hours}h`),
    '',
    kleur.bold('Colony MCP share'),
    `  all tools: ${countRatio(
      payload.colony_mcp_share.colony_mcp_tool_calls,
      payload.colony_mcp_share.total_tool_calls,
      payload.colony_mcp_share.share_of_all_tool_calls,
    )}`,
    `  MCP tools: ${countRatio(
      payload.colony_mcp_share.colony_mcp_tool_calls,
      payload.colony_mcp_share.mcp_tool_calls,
      payload.colony_mcp_share.share_of_mcp_tool_calls,
    )}`,
    '',
    kleur.bold('Loop adoption'),
  ];

  for (const item of Object.values(payload.conversions)) {
    lines.push(
      `  ${item.from_tool} -> ${item.to_tool}: ${countRatio(
        item.converted_sessions,
        item.from_sessions,
        item.conversion_rate,
      )} sessions (${item.from_calls} -> ${item.to_calls} calls)`,
    );
  }

  lines.push(
    '',
    kleur.bold('task_post vs task_message'),
    `  task_post:    ${payload.task_post_vs_task_message.task_post_calls}`,
    `  task_message: ${payload.task_post_vs_task_message.task_message_calls}`,
    `  message share: ${formatPercent(payload.task_post_vs_task_message.task_message_share)}`,
    '',
    kleur.bold('Search calls per session'),
    `  total: ${payload.search_calls_per_session.total_search_calls}`,
    `  avg per active session: ${formatNumber(
      payload.search_calls_per_session.average_per_active_session,
    )}`,
  );

  if (payload.search_calls_per_session.sessions.length === 0) {
    lines.push(kleur.dim('  none'));
  } else {
    for (const row of payload.search_calls_per_session.sessions) {
      lines.push(`  ${shortSession(row.session_id).padEnd(16)} ${row.calls}`);
    }
  }

  lines.push('', kleur.bold('task_claim_file before edits'));
  lines.push(...formatClaimBeforeEdit(payload.task_claim_file_before_edits));

  return lines.join('\n');
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show Colony adoption ratios from local DB evidence')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option('--json', 'emit structured JSON')
    .action(async (opts: { hours: string; json?: boolean }) => {
      const hours = parseHours(opts.hours);
      const settings = loadSettings();
      const { withStorage } = await import('../util/store.js');
      await withStorage(
        settings,
        (storage) => {
          const payload = buildColonyHealthPayload(storage, {
            since: Date.now() - hours * 3_600_000,
            window_hours: hours,
          });
          const formatOptions = opts.json ? { json: true } : {};
          process.stdout.write(`${formatColonyHealthOutput(payload, formatOptions)}\n`);
        },
        { readonly: true },
      );
    });
}

function conversion(calls: ToolCallRow[], fromTool: string, toTool: string): ConversionPayload {
  const fromCalls = countTool(calls, fromTool);
  const toCalls = countTool(calls, toTool);
  const bySession = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const bucket = bySession.get(call.session_id) ?? [];
    bucket.push(call);
    bySession.set(call.session_id, bucket);
  }

  let fromSessions = 0;
  let convertedSessions = 0;
  for (const sessionCalls of bySession.values()) {
    const firstFrom = sessionCalls.find((call) => isColonyTool(call.tool, fromTool));
    if (!firstFrom) continue;
    fromSessions++;
    if (sessionCalls.some((call) => call.ts > firstFrom.ts && isColonyTool(call.tool, toTool))) {
      convertedSessions++;
    }
  }

  return {
    from_tool: fromTool,
    to_tool: toTool,
    from_calls: fromCalls,
    to_calls: toCalls,
    from_sessions: fromSessions,
    converted_sessions: convertedSessions,
    conversion_rate: ratio(convertedSessions, fromSessions),
  };
}

function searchCallsPerSession(calls: ToolCallRow[]): SearchCallsPayload {
  const activeSessions = new Set(calls.map((call) => call.session_id)).size;
  const bySession = new Map<string, number>();
  for (const call of calls) {
    if (!isColonyTool(call.tool, 'search')) continue;
    bySession.set(call.session_id, (bySession.get(call.session_id) ?? 0) + 1);
  }
  const sessions = Array.from(bySession, ([session_id, callCount]) => ({
    session_id,
    calls: callCount,
  }))
    .sort((a, b) => b.calls - a.calls || a.session_id.localeCompare(b.session_id))
    .slice(0, HEALTH_TOOL_LIMIT);
  const totalSearchCalls = Array.from(bySession.values()).reduce((sum, count) => sum + count, 0);
  return {
    total_search_calls: totalSearchCalls,
    active_sessions: activeSessions,
    average_per_active_session: ratio(totalSearchCalls, activeSessions),
    sessions,
  };
}

function claimBeforeEditPayload(
  stats: ClaimBeforeEditStats,
  taskClaimFileCalls: number,
): ClaimBeforeEditPayload {
  const editsWithoutClaimBefore = stats.edits_with_file_path - stats.edits_claimed_before;
  const status =
    stats.edit_tool_calls === 0
      ? 'no_data'
      : stats.edit_tool_calls === stats.edits_with_file_path
        ? 'available'
        : 'not_available';
  return {
    ...stats,
    status,
    task_claim_file_calls: taskClaimFileCalls,
    edits_without_claim_before: editsWithoutClaimBefore,
    claim_before_edit_ratio:
      status === 'available' ? ratio(stats.edits_claimed_before, stats.edits_with_file_path) : null,
  };
}

function formatClaimBeforeEdit(payload: ClaimBeforeEditPayload): string[] {
  const lines = [`  task_claim_file calls: ${payload.task_claim_file_calls}`];
  if (payload.status === 'no_data') {
    lines.push(kleur.dim('  n/a (no edit tool observations in window)'));
    return lines;
  }
  if (payload.status === 'not_available') {
    lines.push(
      `  not available (${payload.edits_with_file_path} / ${payload.edit_tool_calls} edit calls include file_path metadata)`,
    );
    return lines;
  }
  lines.push(
    `  ${payload.edits_claimed_before} / ${payload.edits_with_file_path} edits had explicit claims first (${formatPercent(
      payload.claim_before_edit_ratio,
    )})`,
  );
  lines.push(`  missing proactive claim: ${payload.edits_without_claim_before}`);
  return lines;
}

function countTool(calls: ToolCallRow[], toolName: string): number {
  return calls.filter((call) => isColonyTool(call.tool, toolName)).length;
}

function isMcpTool(tool: string): boolean {
  return tool.startsWith('mcp__') || tool.startsWith('colony.');
}

function isColonyMcpTool(tool: string): boolean {
  return tool.startsWith('mcp__colony__') || tool.startsWith('colony.');
}

function isColonyTool(tool: string, toolName: string): boolean {
  return tool === toolName || tool === `colony.${toolName}` || tool === `mcp__colony__${toolName}`;
}

function conversionKey(fromTool: string, toTool: string): ConversionName {
  return `${fromTool}_to_${toTool}` as ConversionName;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function countRatio(numerator: number, denominator: number, value: number | null): string {
  return `${numerator} / ${denominator} (${formatPercent(value)})`;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function parseHours(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURS;
}

function shortSession(sessionId: string): string {
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 11)}...`;
}
