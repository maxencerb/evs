/** A worker that starts the worker that compiles at run time. */
declare const Worker: new (url: URL, options: { type: 'module' }) => unknown;

export const inner = new Worker(new URL('./worker-compiling.ts', import.meta.url), {
  type: 'module',
});
