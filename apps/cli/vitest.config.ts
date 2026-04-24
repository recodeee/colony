import { readFileSync } from 'node:fs';
import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default mergeConfig(
  rootConfig,
  defineConfig({
    define: { __COLONY_VERSION__: JSON.stringify(version) },
  }),
);
