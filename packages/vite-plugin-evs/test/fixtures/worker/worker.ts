/** A worker that only runs a precompiled script. */
import { inWorker } from './worker.evs.ts';

declare function postMessage(message: unknown): void;

postMessage(inWorker.toViem());
