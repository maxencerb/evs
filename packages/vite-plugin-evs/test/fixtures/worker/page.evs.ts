/** The build-time module of the page. */
import { evscript, t } from '@maxencerb/evs';

export const inPage = evscript({ name: 'inPage' }, (s) => s.return({ page: s.lit(t.uint256, 1n) }))
  .compile()
  .toPrecompiled();
