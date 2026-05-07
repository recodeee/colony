import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Settings } from '@colony/config';
import type { SearchResult } from './types.js';

export type RustSearchMode = 'auto' | 'off' | 'required';

export interface RustSearchOptions {
  rust?: RustSearchMode;
}

interface SearchWithRustParams {
  dbPath: string;
  settings: Settings;
  query: string;
  limit: number;
  mode?: RustSearchMode;
}

interface ResolvedRustSearchConfig {
  enabled: boolean;
  required: boolean;
  binaryPath: string;
  indexDir: string;
  timeoutMs: number;
}

export async function searchWithRust(params: SearchWithRustParams): Promise<SearchResult[] | null> {
  const config = resolveRustSearchConfig(params);
  if (!config.enabled) return null;
  try {
    return await runRustSearch(params, config);
  } catch (err) {
    if (config.required) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Rust search required but unavailable: ${msg}`);
    }
    return null;
  }
}

function resolveRustSearchConfig(params: SearchWithRustParams): ResolvedRustSearchConfig {
  const mode = params.mode ?? 'auto';
  if (mode === 'off') return disabledConfig(params);

  const rust = params.settings.search.rust;
  const envMode = parseRustSearchEnv(process.env.COLONY_RUST_SEARCH);
  if (mode !== 'required' && envMode === 'off') return disabledConfig(params);

  const required =
    mode === 'required' ||
    envMode === 'required' ||
    parseBooleanEnv(process.env.COLONY_RUST_SEARCH_REQUIRED) === true ||
    rust.required;
  const enabled = required || envMode === 'on' || rust.enabled;
  return {
    enabled,
    required,
    binaryPath: process.env.COLONY_RUST_SEARCH_BIN ?? rust.binaryPath ?? 'colony-search',
    indexDir:
      process.env.COLONY_RUST_SEARCH_INDEX_DIR ??
      rust.indexDir ??
      join(dirname(params.dbPath), 'search-index'),
    timeoutMs: parsePositiveInt(process.env.COLONY_RUST_SEARCH_TIMEOUT_MS) ?? rust.timeoutMs,
  };
}

function disabledConfig(params: SearchWithRustParams): ResolvedRustSearchConfig {
  return {
    enabled: false,
    required: false,
    binaryPath: params.settings.search.rust.binaryPath ?? 'colony-search',
    indexDir: params.settings.search.rust.indexDir ?? join(dirname(params.dbPath), 'search-index'),
    timeoutMs: params.settings.search.rust.timeoutMs,
  };
}

function runRustSearch(
  params: SearchWithRustParams,
  config: ResolvedRustSearchConfig,
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.binaryPath, ['search'], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      reject(new Error('failed to open sidecar stdio'));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (err: Error | null, hits?: SearchResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(hits ?? []);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`colony-search timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const suffix = stderr.trim() ? `: ${stderr.trim().slice(-500)}` : '';
        finish(new Error(`colony-search exited ${code ?? signal}${suffix}`));
        return;
      }
      try {
        finish(null, parseRustSearchResponse(stdout));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      `${JSON.stringify({
        db_path: params.dbPath,
        index_dir: config.indexDir,
        query: params.query,
        limit: Math.max(1, Math.floor(params.limit)),
      })}\n`,
    );
  });
}

function parseRustSearchResponse(raw: string): SearchResult[] {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { hits?: unknown }).hits)
  ) {
    throw new Error('invalid Rust search response');
  }
  const hits: SearchResult[] = [];
  for (const item of (parsed as { hits: unknown[] }).hits) {
    const hit = normalizeHit(item);
    if (hit) hits.push(hit);
  }
  return hits;
}

function normalizeHit(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = finiteNumber(row.id);
  const score = finiteNumber(row.score);
  const ts = finiteNumber(row.ts);
  if (id === undefined || score === undefined || ts === undefined) return null;
  return {
    id,
    session_id: typeof row.session_id === 'string' ? row.session_id : '',
    kind: typeof row.kind === 'string' ? row.kind : '',
    snippet: typeof row.snippet === 'string' ? row.snippet : '',
    score,
    ts,
    task_id: typeof row.task_id === 'number' && Number.isFinite(row.task_id) ? row.task_id : null,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseRustSearchEnv(value: string | undefined): 'on' | 'off' | 'required' | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'on';
  if (['0', 'false', 'no', 'off'].includes(normalized)) return 'off';
  if (normalized === 'required') return 'required';
  return undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
