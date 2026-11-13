import { evscript, t } from '@maxencerb/evs';

export const scripts = {
  one: evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) }))
    .compile()
    .toPrecompiled(),
};
