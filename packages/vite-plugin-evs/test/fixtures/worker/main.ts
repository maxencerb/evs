/** A page with a script of its own, which starts a worker that has another. */
import { inPage } from './page.evs.ts';

declare const Worker: new (url: URL, options: { type: 'module' }) => unknown;

export const call = inPage.toViem();
export const start = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
