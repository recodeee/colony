/**
 * Embedder — matches the structural interface in @colony/core.
 *
 * Declared here too so consumers of @colony/embedding don't need to depend
 * on core for the type. The two definitions are kept in sync manually; if
 * they drift, MemoryStore.search will fail to compile against this package.
 */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

export interface EmbeddingFactoryOptions {
  /** Cache directory for local model weights. Defaults to <dataDir>/models. */
  cacheDir?: string;
  /** Stderr logger. Defaults to no-op. */
  log?: (line: string) => void;
}
