import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Library build (`vp pack`, tsdown): one ESM module per source file under dist/ (unbundled, so
  // the published layout mirrors src/ and `sideEffects: false` tree-shaking stays per module),
  // `.js` + `.d.ts` names (`exports` / `main` / `types` point at them), and JS source maps that
  // embed the TypeScript sources (`sourcesContent`) so stack traces and debuggers map to the
  // original code without src/ in the tarball (`files` does not ship it). No declaration maps:
  // go-to-definition lands on the `.d.ts`, which keeps the JSDoc.
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    unbundle: true,
    fixedExtension: false,
    sourcemap: true,
    // rolldown's default, pinned: the published maps are self-contained.
    outputOptions: { sourcemapExcludeSources: false },
    dts: { sourcemap: false },
  },
  test: {
    projects: [
      {
        // The harness self-tests (test/harness/*.test.ts, in-process @ethereumjs/evm —
        // no anvil needed) run in the `unit` project so the regular `vp run test` flow
        // exercises them. The `integration` project (test/integration/**) is unaffected.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/harness/**/*.test.ts'],
          environment: 'node',
          // Threads without per-file isolation: the only mutable module state the unit files
          // touch is the codec-planner test seams (setCodecPlanStrict / setCodecPlanTransform in
          // src/codegen/codecs.ts), which the setup file below resets before each file, and
          // re-importing the compiler + viem per file was the dominant fixed cost once the
          // differential corpus was split into slices (src/differential/*.test.ts).
          pool: 'threads',
          isolate: false,
          // a codec-sharing plan drift is an INTERNAL error in tests (src/codegen/codecs.ts)
          setupFiles: ['./test/setup/strict-codecs.ts'],
        },
      },
      {
        test: {
          name: 'types',
          include: ['src/**/*.test-d.ts'],
          typecheck: { enabled: true, only: true, include: ['src/**/*.test-d.ts'] },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup/strict-codecs.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
