/** The script, not compiled: the build-time module compiles it, and so does the test. */
import { evscript, t } from '@maxencerb/evs';

import { LIMIT } from './limit.ts';

export const aboveLimit = evscript({ name: 'aboveLimit', args: [t.uint256] }, (s, value) =>
  s.return({ above: value.gt(LIMIT) }),
);
