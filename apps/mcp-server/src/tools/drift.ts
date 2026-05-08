import type { MemoryStore } from '@colony/core';
import { FILE_EDIT_TOOLS, normalizeClaimPath } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseMeta } from './_meta.js';
import { type ToolContext, defaultWrapHandler } from './context.js';

export interface DriftCheckResult {
  generated_at: number;
  task_id: number;
  session_id: string;
  window_minutes: number;
  claimed_files: string[];
  edited_files: string[];
  /** Files edited by this session within the window with no matching claim. */
  edits_without_claim: string[];
  /** Claims this session holds with no recent edit activity. */
  claims_without_edits: string[];
  /** Share of edits that fell outside the claim manifest (0..1, two decimals). */
  drift_score: number;
  /**
   * Recommended next action. Caller passes this to the user or to a higher
   * autopilot loop. File-scope drift only — does not analyse semantic drift.
   */
  recommendation: string;
  /** Compact next_tool hint when drift exists; null when nothing to do. */
  next_tool: 'task_claim_file' | null;
  next_args: { session_id: string; task_id: number; file_path: string }[] | null;
}

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_TIMELINE_ROWS = 1000;

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store } = ctx;

  server.tool(
    'task_drift_check',
    "Compare a session's claims for a task against its recent edit-tool observations. Surfaces files edited without a matching claim (drift) and claims with no recent edit activity. File-scope drift only.",
    {
      session_id: z.string().min(1),
      task_id: z.number().int().positive(),
      window_minutes: z.number().int().positive().max(1440).optional(),
    },
    wrapHandler('task_drift_check', async (args) => {
      const result = computeDrift(store, {
        session_id: args.session_id,
        task_id: args.task_id,
        window_minutes: args.window_minutes ?? DEFAULT_WINDOW_MINUTES,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }),
  );
}

export function computeDrift(
  store: MemoryStore,
  args: { session_id: string; task_id: number; window_minutes: number },
): DriftCheckResult {
  const now = Date.now();
  const since = now - args.window_minutes * 60_000;

  const claimedFiles = collectClaimedFiles(store, args.task_id, args.session_id);
  const editedFiles = collectEditedFiles(store, args.task_id, args.session_id, since);

  const editsWithoutClaim = sortedDifference(editedFiles, claimedFiles);
  const claimsWithoutEdits = sortedDifference(claimedFiles, editedFiles);
  const driftScore =
    editedFiles.size === 0 ? 0 : roundTwo(editsWithoutClaim.length / editedFiles.size);

  return {
    generated_at: now,
    task_id: args.task_id,
    session_id: args.session_id,
    window_minutes: args.window_minutes,
    claimed_files: [...claimedFiles].sort(),
    edited_files: [...editedFiles].sort(),
    edits_without_claim: editsWithoutClaim,
    claims_without_edits: claimsWithoutEdits,
    drift_score: driftScore,
    recommendation: buildRecommendation(editsWithoutClaim, claimsWithoutEdits, editedFiles.size),
    next_tool: editsWithoutClaim.length > 0 ? 'task_claim_file' : null,
    next_args:
      editsWithoutClaim.length > 0
        ? editsWithoutClaim.map((file_path) => ({
            session_id: args.session_id,
            task_id: args.task_id,
            file_path,
          }))
        : null,
  };
}

function collectClaimedFiles(store: MemoryStore, taskId: number, sessionId: string): Set<string> {
  const claims = store.storage.listClaims(taskId);
  const out = new Set<string>();
  for (const claim of claims) {
    if (claim.session_id !== sessionId) continue;
    if (claim.state !== 'active') continue;
    const normalized = normalizeForCompare(claim.file_path);
    if (normalized) out.add(normalized);
  }
  return out;
}

function collectEditedFiles(
  store: MemoryStore,
  taskId: number,
  sessionId: string,
  since: number,
): Set<string> {
  const rows = store.storage.taskTimeline(taskId, MAX_TIMELINE_ROWS);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.session_id !== sessionId) continue;
    if (row.kind !== 'tool_use') continue;
    if (row.ts <= since) continue;
    const meta = parseMeta(row.metadata);
    const tool = readString(meta.tool) ?? readString(meta.tool_name);
    if (!tool || !FILE_EDIT_TOOLS.has(tool)) continue;
    const filePath = readString(meta.file_path);
    if (!filePath) continue;
    const normalized = normalizeForCompare(filePath);
    if (normalized) out.add(normalized);
  }
  return out;
}

function sortedDifference(left: Set<string>, right: Set<string>): string[] {
  const out: string[] = [];
  for (const value of left) {
    if (!right.has(value)) out.push(value);
  }
  return out.sort();
}

function buildRecommendation(
  editsWithoutClaim: string[],
  claimsWithoutEdits: string[],
  editedTotal: number,
): string {
  if (editedTotal === 0 && claimsWithoutEdits.length === 0) {
    return 'No edits and no claims in scope. Nothing to reconcile.';
  }
  if (editedTotal === 0) {
    return `No recent edits for ${claimsWithoutEdits.length} held claim(s); release them or post task_note_working before stepping away.`;
  }
  const parts: string[] = [];
  if (editsWithoutClaim.length > 0) {
    parts.push(
      `Claim ${editsWithoutClaim.length} file(s) edited without an active claim: ${truncatePreview(editsWithoutClaim)}.`,
    );
  }
  if (claimsWithoutEdits.length > 0) {
    parts.push(
      `Release or revisit ${claimsWithoutEdits.length} claim(s) with no recent edits: ${truncatePreview(claimsWithoutEdits)}.`,
    );
  }
  if (parts.length === 0) {
    return 'All recent edits are covered by active claims; no drift detected.';
  }
  return parts.join(' ');
}

function truncatePreview(files: string[], limit = 3): string {
  const visible = files.slice(0, limit).join(', ');
  return files.length > limit ? `${visible}, +${files.length - limit} more` : visible;
}

function normalizeForCompare(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path.length === 0) return null;
  try {
    return normalizeClaimPath({ file_path: path }) ?? path;
  } catch {
    return path;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
