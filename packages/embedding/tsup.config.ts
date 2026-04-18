import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Keep @xenova/transformers external — it's an optionalDependency, and
  // bundling it drags in ONNX runtime + sharp (~3 MB) into our dist.
  external: ['@xenova/transformers', '@cavemem/config'],
});
