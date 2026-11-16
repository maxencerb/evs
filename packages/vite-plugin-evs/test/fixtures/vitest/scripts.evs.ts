/**
 * The build-time module of an app that is tested with Vitest. The Vitest tests copy this
 * directory out of the repository, then edit `limit.ts` between two runs.
 */
import { aboveLimit as script } from './above-limit.ts';

export const aboveLimit = script.compile().toPrecompiled();
