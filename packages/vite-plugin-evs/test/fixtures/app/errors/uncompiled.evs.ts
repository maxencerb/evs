import { evscript, t } from '@maxencerb/evs';

export const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) }));
