/** The build-time module of the workspace package. */
import { evscript, t } from '@maxencerb/evs';

export const two = evscript({ name: 'two' }, (s) => s.return({ two: s.lit(t.uint256, 2n) }))
  .compile()
  .toPrecompiled();
