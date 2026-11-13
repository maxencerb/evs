/**
 * Imports a module of the app statically and dynamically, so the bundler warns that the
 * dynamic import moves nothing to a chunk of its own. That module ships the compiler next to a
 * precompiled script, where the bundler has the same to say about a module of evs.
 */
import { calls } from './compiler-static.ts';

export const now = calls;
export const later = () => import('./compiler-static.ts');
