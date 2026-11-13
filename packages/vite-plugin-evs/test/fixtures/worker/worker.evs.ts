/** The build-time module of the worker. */
import { evscript, t } from '@maxencerb/evs';

export const inWorker = evscript({ name: 'inWorker' }, (s) =>
  s.return({ worker: s.lit(t.uint256, 2n) }),
)
  .compile()
  .toPrecompiled();
