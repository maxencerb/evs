/** Takes a run-time helper from the main entry: tree shaking leaves the compiler out. */
import { decodeScriptError } from '@maxencerb/evs';

import { sum } from './scripts.evs.ts';

export const decode = (error: unknown) => decodeScriptError(sum, error);
