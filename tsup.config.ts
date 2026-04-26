import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  splitting: false,
  treeshake: true,
  esbuildOptions(options) {
    options.pure = ['console.log', 'console.debug', 'console.info'];
    options.drop = ['debugger'];
  },
});
