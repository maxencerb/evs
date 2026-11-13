/// <reference types="vite/client" />

/** Asks for the text of a build-time module: a query is another request than the module. */
import source from './scripts.evs.ts?raw';

export { sum } from './scripts.evs.ts';
export { source };
