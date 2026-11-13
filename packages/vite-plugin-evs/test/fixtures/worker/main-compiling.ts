/** A page that keeps the compiler out, and starts a worker that does not. */
import { inPage } from './page.evs.ts';

declare const Worker: new (url: URL, options: { type: 'module' }) => unknown;

export const call = inPage.toViem();
export const start = () =>
  new Worker(new URL('./worker-compiling.ts', import.meta.url), { type: 'module' });
