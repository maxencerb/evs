/** A worker that runs the script of the page. */
import { inPage } from './page.evs.ts';

declare function postMessage(message: unknown): void;

postMessage(inPage.toViem());
