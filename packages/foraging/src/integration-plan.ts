import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '@colony/storage';
import type { IntegrationPlan } from './types.js';

export interface BuildIntegrationPlanOptions {
  repo_root: string;
  example_name: string;
  /** Absolute or repo-relative path to the target package manifest that the
   *  plan should diff against. Defaults to `<repo_root>/package.json`. */
  target_hint?: string;
}

/**
 * Produce a deterministic plan an agent can reason about:
 * - dependency_delta: what the example depends on but the target doesn't,
 *   and anything the target has but the example doesn't list (the `remove`
 *   list is informational, never a recommendation to delete).
 * - files_to_copy: for each indexed filetree-listed entrypoint / manifest,
 *   a suggested destination under the target repo.
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
  const entrypointMetas = observations
    .map((r) => {
      const md = r.metadata ? safeJson(r.metadata) : null;
      return md as { entry_kind?: string; file_path?: string } | null;
    })
    .filter((m): m is { entry_kind: string; file_path: string } => m?.entry_kind === 'entrypoint');

  // Re-read the example's manifest from disk rather than parsing the
  // compressed observation — the compressor preserves technical tokens
  // but the round-trip is still lossy for structured JSON, and we need
  // a fully parseable manifest to diff deps.
  const exampleManifestPath = resolveExampleManifestPath(
    opts.repo_root,
    opts.example_name,
    example.manifest_kind,
  );
  const dependency_delta = buildDependencyDelta(
    example.manifest_kind,
    exampleManifestPath,
    resolveTargetManifestPath(opts.repo_root, opts.target_hint),
    uncertainty_notes,
  );

  const files_to_copy = entrypointMetas.map((m) => ({
    from: `examples/${opts.example_name}/${m.file_path}`,
    to_suggestion: suggestTargetPath(m.file_path),
    rationale: 'Entrypoint indexed from the example; keeps the same directory shape in the target.',
  }));

  const config_steps = extractConfigSteps(example.manifest_kind, exampleManifestPath);

  if (!manifestObs) {
    uncertainty_notes.push('Manifest observation missing — dependency_delta may be incomplete.');
  }
  if (!filetreeObs) {
    uncertainty_notes.push(
      'Filetree observation missing — files_to_copy may not reflect full shape.',
    );
  }

  return {
    example_name: opts.example_name,
    dependency_delta,
    files_to_copy,
    config_steps,
    uncertainty_notes,
  };
}

function emptyPlan(example_name: string, uncertainty_notes: string[]): IntegrationPlan {
  return {
    example_name,
    dependency_delta: { add: {}, remove: [] },
    files_to_copy: [],
    config_steps: [],
    uncertainty_notes,
  };
}

/**
 * For npm manifests we can read both package.jsons and return a true diff.
 * Other kinds produce an empty `add` and an uncertainty note; cross-language
 * dep diffing is too ecosystem-specific to guess at.
 */
function buildDependencyDelta(
  kind: string | null,
  exampleManifestPath: string | null,
  targetManifestPath: string,
  notes: string[],
): { add: Record<string, string>; remove: string[] } {
  if (kind !== 'npm') {
    if (kind && kind !== 'unknown') {
      notes.push(
        `dependency_delta is only computed for npm examples today; '${kind}' left for the agent.`,
      );
    }
    return { add: {}, remove: [] };
  }

  const exampleDeps = exampleManifestPath ? parseNpmDepsFromFile(exampleManifestPath) : null;
  if (!exampleDeps) {
    notes.push('Example manifest could not be read or parsed as JSON; dependency_delta empty.');
    return { add: {}, remove: [] };
  }

  const targetDeps = parseNpmDepsFromFile(targetManifestPath);
  if (targetDeps === null) {
    notes.push(
      `Target manifest not found at ${targetManifestPath}; reporting all example deps as 'add'.`,
    );
  }
  const targetMap = targetDeps ?? {};

  const add: Record<string, string> = {};
  for (const [name, version] of Object.entries(exampleDeps)) {
    if (!(name in targetMap)) add[name] = version;
  }
  const remove: string[] = Object.keys(targetMap).filter((n) => !(n in exampleDeps));

  return { add, remove };
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

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}
