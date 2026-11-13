/**
 * The app of a monorepo: evs is a dependency of the package next to it, not of the app, so
 * `@maxencerb/evs` does not resolve from here. (The tests build a copy outside the repository.)
 */
import { one } from '../lib/index.ts';
import { two } from '../lib/pool.evs.ts';

export const calls = [one.toViem(), two.toViem()];
