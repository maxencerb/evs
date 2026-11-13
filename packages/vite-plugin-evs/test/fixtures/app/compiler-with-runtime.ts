/** Compiles at run time and precompiles nothing, but takes its helpers from the runtime entry. */
import { evscript, t } from '@maxencerb/evs';
import { decodeScriptError } from '@maxencerb/evs/runtime';

const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) })).compile();

export const decode = (error: unknown) => decodeScriptError(one, error);
