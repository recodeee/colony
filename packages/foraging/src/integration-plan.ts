import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '@colony/storage';
import { FORAGING_CONCEPT_RULES, type ForagingConceptTag } from './concepts.js';
import type { ForagedPattern, IntegrationPlan } from './types.js';

export interface BuildIntegrationPlanOptions {
  repo_root: string;
  example_name: string;
  /** Absolute or repo-relative path to the target package manifest that the
   *  plan should diff against. Defaults to `<repo_root>/package.json`. */
  target_hint?: string;
}

/**
 * Produce a deterministic plan an agent can reason about:
 * - dependency_considerations: packages mentioned by the example that may
 *   support a concept, never an instruction to change the target manifest.
 * - concepts_to_port: indexed example patterns that carry behavior ideas,
 *   with source paths used only as references.
 * - config_steps: side-effects the example expects (build scripts, env
 *   variables called out in the manifest) that an integrator must wire up.
 * - uncertainty_notes: every ambiguity the planner couldn't resolve — the
 *   agent reads these and decides, the planner never hides them.
 *
 * No LLM in the loop. Everything here is pulled from the indexed
 * observations or from re-reading the manifests; if that data isn't
 * present, the relevant section is empty and the uncertainty is logged.
 */
export function buildIntegrationPlan(
  storage: Storage,
  opts: BuildIntegrationPlanOptions,
): IntegrationPlan {
  const uncertainty_notes: string[] = [];

  const example = storage.getExample(opts.repo_root, opts.example_name);
  if (!example) {
    uncertainty_notes.push(
      `No indexed row for '${opts.example_name}' — run \`colony foraging scan\` first.`,
    );
    return emptyPlan(opts.example_name, uncertainty_notes);
  }

  const observations = storage.listForagedObservations(opts.repo_root, opts.example_name);
  const manifestObs = observations.find((r) => {
    const md = r.metadata ? safeJson(r.metadata) : null;
    return md && (md as { entry_kind?: string }).entry_kind === 'manifest';
  });
  const filetreeObs = observations.find((r) => {
    const md = r.metadata ? safeJson(r.metadata) : null;
    return md && (md as { entry_kind?: string }).entry_kind === 'filetree';
  });
  const patternMetas = observations
    .map((r) => patternMetaFromJson(r.metadata ? safeJson(r.metadata) : null))
    .filter((m): m is PatternMeta => m !== null);

  // Re-read the example's manifest from disk rather than parsing the
  // compressed observation — the compressor preserves technical tokens
  // but the round-trip is still lossy for structured JSON, and we need
  // a fully parseable manifest to diff deps.
  const exampleManifestPath = resolveExampleManifestPath(
    opts.repo_root,
    opts.example_name,
    example.manifest_kind,
  );
  const dependency_considerations = buildDependencyConsiderations(
    example.manifest_kind,
    exampleManifestPath,
    resolveTargetManifestPath(opts.repo_root, opts.target_hint),
    uncertainty_notes,
  );

  const concepts_to_port = patternMetas.map((m) => ({
    source: `${sourcePathForExample(opts.example_name)}/${m.file_path}`,
    target_hint: suggestTargetPath(m.file_path),
    concept_tags: m.concept_tags,
    rationale:
      'Port concept from this indexed pattern; keep only behavior that fits target boundaries.',
  }));

  const config_steps = extractConfigSteps(example.manifest_kind, exampleManifestPath);

  if (!manifestObs) {
    uncertainty_notes.push(
      'Manifest observation missing — dependency considerations may be incomplete.',
    );
  }
  if (!filetreeObs) {
    uncertainty_notes.push(
      'Filetree observation missing — concept port list may not reflect full shape.',
    );
  }

  return {
    example_name: opts.example_name,
    dependency_considerations,
    concepts_to_port,
    config_steps,
    uncertainty_notes,
  };
}

function emptyPlan(example_name: string, uncertainty_notes: string[]): IntegrationPlan {
  return {
    example_name,
    dependency_considerations: [],
    concepts_to_port: [],
    config_steps: [],
    uncertainty_notes,
  };
}

/**
 * For npm manifests we can read both package.jsons and surface review-only
 * package signals. Other kinds produce no package notes; cross-language
 * dependency reasoning is too ecosystem-specific to guess at.
 */
function buildDependencyConsiderations(
  kind: string | null,
  exampleManifestPath: string | null,
  targetManifestPath: string,
  notes: string[],
): IntegrationPlan['dependency_considerations'] {
  if (kind !== 'npm') {
    if (kind && kind !== 'unknown') {
      notes.push(
        `Package considerations are only computed for npm examples today; '${kind}' left for the agent.`,
      );
    }
    return [];
  }

  const exampleDeps = exampleManifestPath ? parseNpmDepsFromFile(exampleManifestPath) : null;
  if (!exampleDeps) {
    notes.push(
      'Example manifest could not be read or parsed as JSON; package considerations empty.',
    );
    return [];
  }

  const targetDeps = parseNpmDepsFromFile(targetManifestPath);
  if (targetDeps === null) {
    notes.push(
      `Target manifest not found at ${targetManifestPath}; package considerations include example packages for review.`,
    );
  }
  const targetMap = targetDeps ?? {};

  const out: IntegrationPlan['dependency_considerations'] = [];
  for (const [name, version] of Object.entries(exampleDeps)) {
    if (name in targetMap) continue;
    out.push({
      package_name: name,
      version,
      rationale:
        'Package appears in the source example; port concept first, then decide whether the target needs an equivalent runtime package.',
    });
  }

  return out;
}

function parseNpmDepsFromFile(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return null;
  }
}

function resolveExampleManifestPath(
  repo_root: string,
  example_name: string,
  kind: string | null,
): string | null {
  const rufloManifest = resolveRufloManifestPath(repo_root, example_name);
  if (rufloManifest) return rufloManifest;

  const baseDir = join(repo_root, 'examples', example_name);
  switch (kind) {
    case 'npm':
      return join(baseDir, 'package.json');
    case 'pypi':
      return join(baseDir, 'pyproject.toml');
    case 'cargo':
      return join(baseDir, 'Cargo.toml');
    case 'go':
      return join(baseDir, 'go.mod');
    default:
      return null;
  }
}

const RUFLO_MANIFEST_PATHS: Record<string, readonly string[]> = {
  'ruflo-v3-mcp': ['v3/package.json', 'package.json'],
  'ruflo-plugins': ['.claude-plugin/plugin.json', 'package.json'],
  'ruflo-hooks': ['.claude-plugin/hooks/hooks.json', 'package.json'],
  'ruflo-memory': ['v3/@claude-flow/memory/package.json', 'package.json'],
  'ruflo-swarm': ['v3/@claude-flow/swarm/package.json', 'package.json'],
  'ruflo-federation': ['v3/@claude-flow/plugin-agent-federation/package.json', 'package.json'],
  'ruflo-agentdb': ['v3/@claude-flow/memory/package.json', 'package.json'],
  'ruflo-ruvector': ['v3/plugins/ruvector-upstream/package.json', 'package.json'],
};

function resolveRufloManifestPath(repo_root: string, example_name: string): string | null {
  const candidates = RUFLO_MANIFEST_PATHS[example_name];
  if (!candidates) return null;
  const base = join(repo_root, 'examples', 'ruflo');
  for (const rel of candidates) {
    const abs = join(base, rel);
    if (existsSync(abs)) return abs;
  }
  return join(base, candidates[candidates.length - 1] ?? 'package.json');
}

function sourcePathForExample(example_name: string): string {
  return example_name.startsWith('ruflo-') ? 'examples/ruflo' : `examples/${example_name}`;
}

/**
 * Very conservative suggestion: keep the in-example path as-is. Agents
 * move files around intentionally; giving them a cleaned-up shape
 * to deviate from is more useful than inventing a destination.
 */
function suggestTargetPath(relFromExample: string): string {
  return relFromExample;
}

function extractConfigSteps(kind: string | null, manifestPath: string | null): string[] {
  if (kind !== 'npm' || !manifestPath) return [];
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const out: string[] = [];
    for (const name of ['build', 'dev', 'start', 'test'] as const) {
      if (scripts[name]) out.push(`npm run ${name}`);
    }
    return out;
  } catch {
    return [];
  }
}

function resolveTargetManifestPath(repo_root: string, hint?: string): string {
  if (!hint) return join(repo_root, 'package.json');
  // Allow both absolute and repo-relative hints. Keep it simple: if it
  // looks absolute, use it as-is; otherwise join onto repo_root.
  return hint.startsWith('/') ? hint : join(repo_root, hint);
}

type PatternMeta = {
  entry_kind: Extract<ForagedPattern['entry_kind'], 'manifest' | 'readme' | 'entrypoint'>;
  file_path: string;
  concept_tags: ForagingConceptTag[];
};

const KNOWN_CONCEPT_TAGS = new Set<string>(FORAGING_CONCEPT_RULES.map((rule) => rule.tag));

function patternMetaFromJson(md: unknown): PatternMeta | null {
  if (!md || typeof md !== 'object') return null;
  const raw = md as { entry_kind?: unknown; file_path?: unknown; concept_tags?: unknown };
  if (
    raw.entry_kind !== 'manifest' &&
    raw.entry_kind !== 'readme' &&
    raw.entry_kind !== 'entrypoint'
  ) {
    return null;
  }
  if (typeof raw.file_path !== 'string') return null;
  return {
    entry_kind: raw.entry_kind,
    file_path: raw.file_path,
    concept_tags: normalizeConceptTags(raw.concept_tags),
  };
}

function normalizeConceptTags(value: unknown): ForagingConceptTag[] {
  if (!Array.isArray(value)) return [];
  const tags: ForagingConceptTag[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !KNOWN_CONCEPT_TAGS.has(item)) continue;
    tags.push(item as ForagingConceptTag);
  }
  return [...new Set(tags)];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}
