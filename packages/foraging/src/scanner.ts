import { createHash } from 'node:crypto';
import { type Stats, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore } from '@colony/core';
import type { ForagingConceptTag } from './concepts.js';
import { type ExtractedShape, extract, readCapped } from './extractor.js';
import { indexFoodSource } from './indexer.js';
import {
  DEFAULT_SCAN_LIMITS,
  type ExampleManifestKind,
  type FoodSource,
  type ScanLimits,
  type ScanResult,
} from './types.js';

export interface ScanFsOptions {
  repo_root: string;
  limits?: Partial<ScanLimits>;
}

export interface ScanFsResult {
  scanned: FoodSource[];
  suppressed_examples?: string[];
}

interface RufloSubSourceSpec {
  example_name: string;
  manifest_kind: ExampleManifestKind;
  manifest_path: string | null;
  readme_path: string | null;
  entrypoints: readonly string[];
  filetree_paths: readonly string[];
  concept_tags: readonly ForagingConceptTag[];
}

const COCOINDEX_EXAMPLE_NAME = 'cocoindex';
const COCOINDEX_SOURCE_PATH = 'examples/cocoindex';
const COCOINDEX_SUB_SOURCES: readonly RufloSubSourceSpec[] = [
  {
    example_name: 'cocoindex-skill',
    manifest_kind: 'unknown',
    manifest_path: null,
    readme_path: 'skills/cocoindex/SKILL.md',
    entrypoints: [
      'skills/cocoindex/SKILL.md',
      'skills/cocoindex/references/api_reference.md',
      'skills/cocoindex/references/connectors.md',
      'skills/cocoindex/references/patterns.md',
      'skills/cocoindex/references/setup_database.md',
      'skills/cocoindex/references/setup_project.md',
    ],
    filetree_paths: ['skills/cocoindex/', 'skills/cocoindex/references/'],
    concept_tags: ['pattern-memory', 'trigger-routing'],
  },
  {
    example_name: 'cocoindex-python',
    manifest_kind: 'pypi',
    manifest_path: 'pyproject.toml',
    readme_path: 'README.md',
    entrypoints: [
      'python/cocoindex/__init__.py',
      'python/cocoindex/cli.py',
      'python/cocoindex/user_app_loader.py',
      'python/cocoindex/_internal/app.py',
      'python/cocoindex/_internal/runner.py',
      'python/cocoindex/ops/text.py',
    ],
    filetree_paths: [
      'python/cocoindex/',
      'python/cocoindex/_internal/',
      'python/cocoindex/connectorkits/',
      'python/cocoindex/ops/',
      'python/cocoindex/resources/',
    ],
    concept_tags: ['pattern-memory'],
  },
  {
    example_name: 'cocoindex-rust',
    manifest_kind: 'cargo',
    manifest_path: 'Cargo.toml',
    readme_path: 'README.md',
    entrypoints: [
      'rust/core/src/lib.rs',
      'rust/py/src/lib.rs',
      'rust/py/src/app.rs',
      'rust/py/src/runtime.rs',
      'rust/ops_text/src/lib.rs',
      'rust/utils/src/fingerprint.rs',
    ],
    filetree_paths: ['rust/core/', 'rust/ops_text/', 'rust/py/', 'rust/py_utils/', 'rust/utils/'],
    concept_tags: ['sidecar-runtime', 'token-budget'],
  },
  {
    example_name: 'cocoindex-examples',
    manifest_kind: 'pypi',
    manifest_path: 'pyproject.toml',
    readme_path: 'README.md',
    entrypoints: [
      'examples/code_embedding/main.py',
      'examples/code_embedding_lancedb/main.py',
      'examples/conversation_to_knowledge/conv_knowledge/app.py',
      'examples/csv_to_kafka/main.py',
      'examples/entire_session_search/main.py',
      'examples/multi_codebase_summarization/main.py',
      'examples/pdf_embedding/main.py',
      'examples/patient_intake_extraction_baml/main.py',
    ],
    filetree_paths: [
      'examples/code_embedding/',
      'examples/code_embedding_lancedb/',
      'examples/conversation_to_knowledge/',
      'examples/csv_to_kafka/',
      'examples/entire_session_search/',
      'examples/multi_codebase_summarization/',
      'examples/pdf_embedding/',
      'examples/patient_intake_extraction_baml/',
    ],
    concept_tags: ['pattern-memory'],
  },
  {
    example_name: 'cocoindex-docs',
    manifest_kind: 'npm',
    manifest_path: 'docs/package.json',
    readme_path: 'README.md',
    entrypoints: [
      'docs/src/content/docs/getting_started/ai_coding_agents.mdx',
      'docs/src/content/docs/getting_started/quickstart.mdx',
      'docs/src/content/docs/programming_guide/app.mdx',
      'docs/src/content/docs/programming_guide/core_concepts.mdx',
      'docs/src/content/docs/ops/text.mdx',
    ],
    filetree_paths: [
      'README.md',
      'docs/src/content/docs/',
      'docs/src/content/docs/getting_started/',
      'docs/src/content/docs/programming_guide/',
      'docs/src/content/docs/ops/',
    ],
    concept_tags: ['pattern-memory', 'token-budget'],
  },
];

const RUFLO_EXAMPLE_NAME = 'ruflo';
const RUFLO_SOURCE_PATH = 'examples/ruflo';
const RUFLO_SUB_SOURCES: readonly RufloSubSourceSpec[] = [
  {
    example_name: 'ruflo-v3-mcp',
    manifest_kind: 'npm',
    manifest_path: 'v3/package.json',
    readme_path: 'v3/README.md',
    entrypoints: [
      'v3/mcp/server-entry.ts',
      'v3/mcp/server.ts',
      'v3/mcp/tool-registry.ts',
      'v3/mcp/session-manager.ts',
      'v3/mcp/connection-pool.ts',
      'v3/mcp/index.ts',
    ],
    filetree_paths: ['v3/', 'v3/mcp/'],
    concept_tags: ['mcp-bridge', 'tool-catalog'],
  },
  {
    example_name: 'ruflo-plugins',
    manifest_kind: 'unknown',
    manifest_path: '.claude-plugin/plugin.json',
    readme_path: 'plugins/README.md',
    entrypoints: [
      '.claude-plugin/marketplace.json',
      '.claude-plugin/hooks/hooks.json',
      'plugin/.claude-plugin/plugin.json',
      'plugin/hooks/hooks.json',
    ],
    filetree_paths: ['.claude-plugin/', '.claude-plugin/hooks/', 'plugin/', 'plugins/'],
    concept_tags: ['plugin-registry', 'tool-catalog'],
  },
  {
    example_name: 'ruflo-hooks',
    manifest_kind: 'unknown',
    manifest_path: '.claude-plugin/hooks/hooks.json',
    readme_path: '.claude/helpers/README.md',
    entrypoints: [
      '.claude/helpers/hook-handler.cjs',
      '.claude/helpers/context-persistence-hook.mjs',
      '.claude/helpers/guidance-hook.sh',
      '.claude/helpers/memory.cjs',
      '.claude/helpers/router.cjs',
    ],
    filetree_paths: ['.claude/', '.claude/helpers/', '.claude-plugin/hooks/'],
    concept_tags: ['sidecar-runtime', 'trigger-routing'],
  },
  {
    example_name: 'ruflo-memory',
    manifest_kind: 'npm',
    manifest_path: 'v3/@claude-flow/memory/package.json',
    readme_path: 'v3/@claude-flow/memory/README.md',
    entrypoints: [
      'v3/@claude-flow/memory/src/index.ts',
      'v3/@claude-flow/memory/src/hybrid-backend.ts',
      'v3/@claude-flow/memory/src/smart-retrieval.ts',
      'v3/@claude-flow/memory/src/auto-memory-bridge.ts',
      '.claude/helpers/memory.cjs',
      '.claude/helpers/auto-memory-hook.mjs',
    ],
    filetree_paths: ['v3/@claude-flow/memory/', 'v3/@claude-flow/memory/src/', '.claude/helpers/'],
    concept_tags: ['pattern-memory', 'agentdb'],
  },
  {
    example_name: 'ruflo-swarm',
    manifest_kind: 'npm',
    manifest_path: 'v3/@claude-flow/swarm/package.json',
    readme_path: 'v3/@claude-flow/swarm/README.md',
    entrypoints: [
      'v3/@claude-flow/swarm/src/index.ts',
      'v3/@claude-flow/swarm/src/queen-coordinator.ts',
      'v3/@claude-flow/swarm/src/topology-manager.ts',
      'v3/@claude-flow/swarm/src/message-bus.ts',
      'v3/swarm.config.ts',
      '.claude/helpers/swarm-comms.sh',
      '.claude/helpers/swarm-hooks.sh',
    ],
    filetree_paths: ['v3/@claude-flow/swarm/', 'v3/@claude-flow/swarm/src/', '.claude/helpers/'],
    concept_tags: ['ready-work-ranking', 'goal-planning'],
  },
  {
    example_name: 'ruflo-federation',
    manifest_kind: 'npm',
    manifest_path: 'v3/@claude-flow/plugin-agent-federation/package.json',
    readme_path: 'v3/@claude-flow/plugin-agent-federation/README.md',
    entrypoints: [
      'v3/@claude-flow/plugin-agent-federation/src/index.ts',
      'v3/@claude-flow/plugin-agent-federation/src/plugin.ts',
      'v3/@claude-flow/plugin-agent-federation/src/mcp-tools.ts',
      'v3/@claude-flow/plugin-agent-federation/src/cli-commands.ts',
      'v3/mcp/tools/federation-tools.ts',
      'plugins/ruflo-federation/README.md',
    ],
    filetree_paths: [
      'v3/@claude-flow/plugin-agent-federation/',
      'v3/@claude-flow/plugin-agent-federation/src/',
      'v3/mcp/tools/',
      'plugins/ruflo-federation/',
    ],
    concept_tags: ['federation', 'mcp-bridge'],
  },
  {
    example_name: 'ruflo-agentdb',
    manifest_kind: 'npm',
    manifest_path: 'v3/@claude-flow/memory/package.json',
    readme_path: 'plugins/ruflo-agentdb/README.md',
    entrypoints: [
      'v3/@claude-flow/memory/src/agentdb-adapter.ts',
      'v3/@claude-flow/memory/src/agentdb-backend.ts',
      'v3/@claude-flow/memory/examples/agentdb-example.ts',
      'plugins/ruflo-agentdb/.claude-plugin/plugin.json',
      'plugins/ruflo-agentdb/commands/agentdb.md',
    ],
    filetree_paths: ['v3/@claude-flow/memory/src/', 'plugins/ruflo-agentdb/'],
    concept_tags: ['agentdb', 'pattern-memory'],
  },
  {
    example_name: 'ruflo-ruvector',
    manifest_kind: 'npm',
    manifest_path: 'v3/plugins/ruvector-upstream/package.json',
    readme_path: 'v3/plugins/ruvector-upstream/README.md',
    entrypoints: [
      'v3/plugins/ruvector-upstream/src/index.ts',
      'v3/plugins/ruvector-upstream/src/registry.ts',
      'v3/plugins/ruvector-upstream/src/types.ts',
      'v3/@claude-flow/providers/src/ruvector-provider.ts',
      'plugins/ruflo-ruvector/.claude-plugin/plugin.json',
    ],
    filetree_paths: [
      'v3/plugins/ruvector-upstream/',
      'v3/plugins/ruvector-upstream/src/',
      'v3/@claude-flow/providers/src/',
      'plugins/ruflo-ruvector/',
    ],
    concept_tags: ['ruvector', 'pattern-memory'],
  },
];

/**
 * Discover food sources on disk without touching storage. Storage-aware
 * `scanExamples` (next PR) wraps this and decides which of the returned
 * sources to actually index based on `storage.getExample` hashes.
 *
 * Decoupling is deliberate: (a) the fs walk is pure and easy to test in
 * isolation, (b) the storage-aware wrapper can stay a thin orchestrator
 * with no fs logic of its own.
 */
export function scanExamplesFs(opts: ScanFsOptions): ScanFsResult {
  const limits = mergeLimits(opts.limits);
  const examplesDir = join(opts.repo_root, 'examples');

  let names: string[];
  try {
    names = readdirSync(examplesDir);
  } catch {
    return { scanned: [] };
  }
  names.sort();

  const scanned: FoodSource[] = [];
  const suppressed_examples: string[] = [];
  for (const example_name of names) {
    const abs_path = join(examplesDir, example_name);
    let isDir = false;
    try {
      isDir = statSync(abs_path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    if (example_name === COCOINDEX_EXAMPLE_NAME && isLargeCocoindexExample(abs_path)) {
      scanned.push(...buildCocoindexSubSources(opts.repo_root, abs_path, limits));
      suppressed_examples.push(example_name);
      continue;
    }

    if (example_name === RUFLO_EXAMPLE_NAME && isLargeRufloExample(abs_path)) {
      scanned.push(...buildRufloSubSources(opts.repo_root, abs_path, limits));
      suppressed_examples.push(example_name);
      continue;
    }

    const shape = extract(abs_path, limits);
    const content_hash = computeContentHash(abs_path, shape, limits);
    scanned.push({
      repo_root: opts.repo_root,
      example_name,
      abs_path,
      manifest_kind: shape.manifest_kind,
      manifest_path: shape.manifest_path,
      readme_path: shape.readme_path,
      entrypoints: shape.entrypoints,
      file_tree: shape.file_tree,
      skipped_files: shape.skipped_files,
      content_hash,
    });
  }
  return suppressed_examples.length > 0 ? { scanned, suppressed_examples } : { scanned };
}

function isLargeCocoindexExample(abs_path: string): boolean {
  return (
    directoryExists(join(abs_path, 'python')) &&
    directoryExists(join(abs_path, 'rust')) &&
    directoryExists(join(abs_path, 'skills'))
  );
}

function isLargeRufloExample(abs_path: string): boolean {
  return directoryExists(join(abs_path, 'v3')) && directoryExists(join(abs_path, 'plugins'));
}

function buildCocoindexSubSources(
  repo_root: string,
  abs_path: string,
  limits: ScanLimits,
): FoodSource[] {
  return buildSubSources(repo_root, abs_path, COCOINDEX_SOURCE_PATH, COCOINDEX_SUB_SOURCES, limits);
}

function buildRufloSubSources(
  repo_root: string,
  abs_path: string,
  limits: ScanLimits,
): FoodSource[] {
  return buildSubSources(repo_root, abs_path, RUFLO_SOURCE_PATH, RUFLO_SUB_SOURCES, limits);
}

function buildSubSources(
  repo_root: string,
  abs_path: string,
  source_path: string,
  specs: readonly RufloSubSourceSpec[],
  limits: ScanLimits,
): FoodSource[] {
  const out: FoodSource[] = [];
  for (const spec of specs) {
    const manifest_path =
      spec.manifest_path && fileExists(join(abs_path, spec.manifest_path))
        ? spec.manifest_path
        : null;
    const readme_path =
      spec.readme_path && fileExists(join(abs_path, spec.readme_path)) ? spec.readme_path : null;
    const entrypoints = spec.entrypoints.filter((p) => fileExists(join(abs_path, p)));
    const filetree_paths = compactExistingPaths(abs_path, [
      ...spec.filetree_paths,
      ...(manifest_path ? [manifest_path] : []),
      ...(readme_path ? [readme_path] : []),
      ...entrypoints,
    ]);
    if (!manifest_path && !readme_path && entrypoints.length === 0 && filetree_paths.length === 0) {
      continue;
    }
    out.push({
      repo_root,
      example_name: spec.example_name,
      abs_path,
      source_path,
      manifest_kind: manifest_path ? spec.manifest_kind : 'unknown',
      manifest_path,
      readme_path,
      entrypoints,
      file_tree: [],
      skipped_files: [],
      filetree_paths,
      concept_tags: Array.from(new Set(spec.concept_tags)).sort(),
      content_hash: computeRufloContentHash(abs_path, spec.example_name, filetree_paths, limits),
    });
  }
  return out;
}

function compactExistingPaths(abs_path: string, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const abs = join(abs_path, p);
    try {
      const st = statSync(abs);
      out.add(st.isDirectory() ? `${p.replace(/\/$/, '')}/` : p);
    } catch {}
  }
  return Array.from(out).sort();
}

function computeRufloContentHash(
  abs_path: string,
  example_name: string,
  filetree_paths: readonly string[],
  limits: ScanLimits,
): string {
  const hash = createHash('sha256');
  hash.update(`ruflo-sub-source:${example_name}\n`);
  for (const rel of filetree_paths) {
    const cleanRel = rel.replace(/\/$/, '');
    const abs = join(abs_path, cleanRel);
    let st: Stats;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    hash.update(`${rel}\t${st.size}\n`);
    if (st.isFile()) {
      const text = readCapped(abs, limits.max_file_bytes);
      if (text !== null) hash.update(text);
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function fileExists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function directoryExists(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Stable hash of (manifest bytes, sorted {path,size} pairs). Chosen
 * over "hash every file" because the hash runs on every SessionStart
 * and must finish in milliseconds. Size + path shifts are a sufficient
 * change signal: an edit to any tracked file moves the size, a rename
 * moves the path, a new file moves the set. A pure content-preserving
 * edit (touch, whitespace-only, etc.) will miss — acceptable since the
 * cached observations already encode the meaningful content.
 */
function computeContentHash(abs_path: string, shape: ExtractedShape, limits: ScanLimits): string {
  const hash = createHash('sha256');
  if (shape.manifest_path) {
    const manifest = readCapped(join(abs_path, shape.manifest_path), limits.max_file_bytes);
    if (manifest !== null) {
      hash.update(`manifest:${shape.manifest_path}\n`);
      hash.update(manifest);
      hash.update('\n');
    }
  }
  hash.update('filetree:\n');
  for (const f of shape.file_tree.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${f.path}\t${f.size}\n`);
  }
  hash.update('skipped:\n');
  for (const f of shape.skipped_files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${f.path}\t${f.skipped_due_to}\t${f.size ?? ''}\t${f.entry_type}\n`);
  }
  return hash.digest('hex');
}

function mergeLimits(partial?: Partial<ScanLimits>): ScanLimits {
  return {
    max_depth: partial?.max_depth ?? DEFAULT_SCAN_LIMITS.max_depth,
    max_file_bytes: partial?.max_file_bytes ?? DEFAULT_SCAN_LIMITS.max_file_bytes,
    max_files_per_source: partial?.max_files_per_source ?? DEFAULT_SCAN_LIMITS.max_files_per_source,
  };
}

export interface ScanOptions {
  repo_root: string;
  store: MemoryStore;
  session_id: string;
  limits?: Partial<ScanLimits>;
  extra_secret_env_names?: readonly string[];
}

/**
 * Storage-aware scan. For each discovered food source: check the
 * cached `content_hash` on `storage.examples`. If unchanged, skip.
 * Otherwise clear stale observations, re-index, and upsert the
 * examples row with the new hash + observation count.
 *
 * Idempotent by construction: running twice on an unchanged tree
 * yields the same result the second time (all skipped). A partial
 * failure mid-index means the examples row is not upserted, so the
 * next run treats the source as changed and retries cleanly.
 */
export function scanExamples(opts: ScanOptions): ScanResult {
  const { scanned, suppressed_examples } = scanExamplesFs({
    repo_root: opts.repo_root,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  });
  let skipped_unchanged = 0;
  let indexed_observations = 0;

  for (const example_name of suppressed_examples ?? []) {
    opts.store.storage.deleteForagedObservations(opts.repo_root, example_name);
    opts.store.storage.deleteExample(opts.repo_root, example_name);
  }

  for (const food of scanned) {
    const existing = opts.store.storage.getExample(food.repo_root, food.example_name);
    if (existing && existing.content_hash === food.content_hash) {
      skipped_unchanged += 1;
      continue;
    }

    opts.store.storage.deleteForagedObservations(food.repo_root, food.example_name);

    const options: Parameters<typeof indexFoodSource>[2] = {
      session_id: opts.session_id,
      ...(opts.limits?.max_file_bytes !== undefined
        ? { max_file_bytes: opts.limits.max_file_bytes }
        : {}),
      ...(opts.extra_secret_env_names !== undefined
        ? { extra_secret_env_names: opts.extra_secret_env_names }
        : {}),
    };
    const count = indexFoodSource(food, opts.store, options);
    indexed_observations += count;

    opts.store.storage.upsertExample({
      repo_root: food.repo_root,
      example_name: food.example_name,
      content_hash: food.content_hash,
      manifest_kind: food.manifest_kind,
      observation_count: count,
    });
  }

  return { scanned, skipped_unchanged, indexed_observations };
}
