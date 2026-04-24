import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export const workspaceAliases = {
  '@colony/compress': resolve(rootDir, 'packages/compress/src/index.ts'),
  '@colony/config': resolve(rootDir, 'packages/config/src/index.ts'),
  '@colony/core': resolve(rootDir, 'packages/core/src/index.ts'),
  '@colony/embedding': resolve(rootDir, 'packages/embedding/src/index.ts'),
  '@colony/hooks': resolve(rootDir, 'packages/hooks/src/index.ts'),
  '@colony/installers': resolve(rootDir, 'packages/installers/src/index.ts'),
  '@colony/mcp-server': resolve(rootDir, 'apps/mcp-server/src/server.ts'),
  '@colony/storage': resolve(rootDir, 'packages/storage/src/index.ts'),
  '@colony/worker': resolve(rootDir, 'apps/worker/src/server.ts'),
};

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
});
