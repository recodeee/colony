import type { Settings } from '@colony/config';
import type { Embedder, MemoryStore, WorktreeContentionReport } from '@colony/core';

export type ToolHandlerWrapper = <Args extends unknown[], Result>(
  name: string,
  handler: (...args: Args) => Result,
) => (...args: Args) => Result;

export const defaultWrapHandler: ToolHandlerWrapper = (_name, handler) => handler;

/** Shared closure captured by every register(server, ctx) call in tools/*.ts. */
export interface ToolContext {
  store: MemoryStore;
  settings: Settings;
  planValidation?: PlanValidationRuntime;
  /**
   * Lazy-singleton embedder. Returns null when the provider is `none` or the
   * model failed to load. The first `search` call pays the model-load cost;
   * every subsequent call reuses the cached instance.
   */
  resolveEmbedder: () => Promise<Embedder | null>;
  wrapHandler?: ToolHandlerWrapper;
}

export interface PlanValidationRuntime {
  now?: () => number;
  readWorktreeContention?: (repoRoot: string) => WorktreeContentionReport;
  availableMcpTools?: string[];
  requiredMcpTools?: string[];
  quotaRiskRuntimes?: PlanValidationQuotaRiskRuntime[];
  omxNotes?: PlanValidationOmxNote[];
  protectedFilePatterns?: string[];
  strictClaimPolicy?: boolean;
}

export interface PlanValidationQuotaRiskRuntime {
  agent: string;
  session_id?: string;
  reason: 'quota' | 'rate-limit' | 'turn-cap' | 'unknown';
  capability_hints?: Array<'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work'>;
}

export interface PlanValidationOmxNote {
  session_id: string;
  content: string;
  file_paths?: string[];
}
