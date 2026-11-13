/** Compiles at run time and precompiles nothing: no build-time module is part of the build. */
import { evscript, t } from '@maxencerb/evs';

export const one = evscript({ name: 'one' }, (s) =>
  s.return({ one: s.lit(t.uint256, 1n) }),
).compile();
