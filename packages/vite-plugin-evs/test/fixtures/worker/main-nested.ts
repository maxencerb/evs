/** A page whose worker starts a worker of its own: the scripts are two bundles down. */
declare const Worker: new (url: URL, options: { type: 'module' }) => unknown;

export const start = () =>
  new Worker(new URL('./worker-nesting.ts', import.meta.url), { type: 'module' });
