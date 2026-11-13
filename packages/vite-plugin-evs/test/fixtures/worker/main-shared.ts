/** A page and its worker that run the same script. */
import { inPage } from './page.evs.ts';

declare const Worker: new (url: URL, options: { type: 'module' }) => unknown;

export const call = inPage.toViem();
export const start = () =>
  new Worker(new URL('./worker-shared.ts', import.meta.url), { type: 'module' });
