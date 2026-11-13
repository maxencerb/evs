/** Precompiles one script and compiles another at run time: the compiler is loaded up front. */
import { evscript, t } from '@maxencerb/evs';

import { sum } from './scripts.evs.ts';

const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) })).compile();

export const calls = [sum.toViem(), one.toViem()];
