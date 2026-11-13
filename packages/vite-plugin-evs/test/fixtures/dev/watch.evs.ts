/** Copied to a temporary directory by the dev-server tests, which then edit `limit.ts`. */
import { evscript, t } from '@maxencerb/evs';

import { LIMIT } from './limit.ts';

export const limit = LIMIT;

export const aboveLimit = evscript({ name: 'aboveLimit', args: [t.uint256] }, (s, value) =>
  s.return({ above: value.gt(LIMIT) }),
)
  .compile()
  .toPrecompiled();
