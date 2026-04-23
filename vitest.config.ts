import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export const workspaceAliases = {
  '@cavemem/compress': resolve(rootDir, 'packages/compress/src/index.ts'),
  '@cavemem/config': resolve(rootDir, 'packages/config/src/index.ts'),
  '@cavemem/core': resolve(rootDir, 'packages/core/src/index.ts'),
  '@cavemem/embedding': resolve(rootDir, 'packages/embedding/src/index.ts'),
  '@cavemem/hooks': resolve(rootDir, 'packages/hooks/src/index.ts'),
  '@cavemem/installers': resolve(rootDir, 'packages/installers/src/index.ts'),
  '@cavemem/mcp-server': resolve(rootDir, 'apps/mcp-server/src/server.ts'),
  '@cavemem/storage': resolve(rootDir, 'packages/storage/src/index.ts'),
  '@cavemem/worker': resolve(rootDir, 'apps/worker/src/server.ts'),
};

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
});
