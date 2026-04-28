import type { Settings } from '@colony/config';
import type { Embedder, MemoryStore } from '@colony/core';

export type ToolHandlerWrapper = <Args extends unknown[], Result>(
  name: string,
  handler: (...args: Args) => Result,
) => (...args: Args) => Result;

export const defaultWrapHandler: ToolHandlerWrapper = (_name, handler) => handler;

/** Shared closure captured by every register(server, ctx) call in tools/*.ts. */
export interface ToolContext {
  store: MemoryStore;
  settings: Settings;
  /**
   * Lazy-singleton embedder. Returns null when the provider is `none` or the
   * model failed to load. The first `search` call pays the model-load cost;
   * every subsequent call reuses the cached instance.
   */
  resolveEmbedder: () => Promise<Embedder | null>;
  wrapHandler?: ToolHandlerWrapper;
}
