/**
 * Foraging's domain model: an `examples/<name>/` directory is a "food
 * source" an agent can forage from. Scanner discovers food sources,
 * extractor classifies their shape, indexer (PR 3) turns the shape into
 * observations. This module owns the type boundary between those stages.
 */

export type ExampleManifestKind = 'npm' | 'pypi' | 'cargo' | 'go' | 'unknown';

export type ForagingSkipReason = 'too_large' | 'generated' | 'binary' | 'nested_git' | 'budget';

export interface ForagedFileEntry {
  path: string;
  size: number;
}

export interface SkippedForagedFile {
  path: string;
  skipped_due_to: ForagingSkipReason;
  size: number | null;
  entry_type: 'file' | 'directory';
}

/**
 * What a single `<repo_root>/examples/<name>/` looks like after the
 * extractor classifies it. Paths inside are *relative to abs_path* so
 * the indexer can stitch them onto whatever `repo_root` it receives
 * later without re-walking.
 */
export interface FoodSource {
  repo_root: string;
  example_name: string;
  abs_path: string;
  manifest_kind: ExampleManifestKind;
  manifest_path: string | null;
  readme_path: string | null;
  entrypoints: string[];
  file_tree: ForagedFileEntry[];
  skipped_files: SkippedForagedFile[];
  content_hash: string;
}

/**
 * A unit of content the indexer will persist as one observation. Stays
 * intentionally minimal: the redacted, pre-compress text plus enough
 * metadata for `examples_query` to filter without a JOIN.
 */
export interface ForagedPattern {
  example_name: string;
  file_path: string;
  entry_kind: 'manifest' | 'readme' | 'filetree' | 'entrypoint' | 'config' | 'skipped';
  content: string;
  skipped_due_to?: ForagingSkipReason;
  size?: number | null;
}

/**
 * Deterministic plan handed to an agent by `examples_integrate_plan`.
 * No LLM in the loop — the plan is derived from the example's manifest
 * diffed against the target repo's manifest. `uncertainty_notes`
 * captures everything the planner couldn't resolve so the agent knows
 * where to apply judgement.
 */
export interface IntegrationPlan {
  example_name: string;
  dependency_delta: {
    add: Record<string, string>;
    remove: string[];
  };
  files_to_copy: Array<{ from: string; to_suggestion: string; rationale: string }>;
  config_steps: string[];
  uncertainty_notes: string[];
}

export interface ScanResult {
  scanned: FoodSource[];
  skipped_unchanged: number;
  indexed_observations: number;
}

export interface ScanLimits {
  max_depth: number;
  max_file_bytes: number;
  max_files_per_source: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  max_depth: 2,
  max_file_bytes: 200_000,
  max_files_per_source: 50,
};
