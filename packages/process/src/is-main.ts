import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Returns true when the caller's module is the entrypoint Node was invoked with.
 *
 * Pass the caller's `import.meta.url`. The comparison normalizes both sides
 * through `pathToFileURL(realpathSync(...))` so it works when the binary is
 * reached through an npm-installed symlink in `node_modules/.bin` — the
 * original motivation for this helper (0.2.0 release notes: "binary works when
 * invoked through npm's symlinked `bin/` shim").
 */
export function isMainEntry(importMetaUrl: string): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return importMetaUrl === pathToFileURL(argv).href;
  }
}
