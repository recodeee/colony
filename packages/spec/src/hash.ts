import { readFileSync } from 'node:fs';
import { parseSpec } from './grammar.js';

// Deterministic, dependency-free hash of the current root SPEC.md.
// Used as the three-way-merge ancestor for every in-flight change.
//
// Stability requirements:
//   - Same file contents -> same hash across machines and Node versions.
//   - Whitespace normalized so that formatting-only edits don't invalidate
//     every in-flight change.
//   - Invariant: computeBaseRootHash(f) === parseSpec(readFile(f)).rootHash.
export function computeBaseRootHash(specPath: string): string {
  const text = readFileSync(specPath, 'utf8');
  return parseSpec(text).rootHash;
}

// Verify that a change's captured baseRootHash still matches the current
// root. Returns false iff the root has drifted since /co:change was run.
export function verifyBaseRootHash(specPath: string, recorded: string): boolean {
  try {
    const current = computeBaseRootHash(specPath);
    return current === recorded;
  } catch {
    return false;
  }
}
