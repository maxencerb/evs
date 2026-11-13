import { evscript, t } from '@maxencerb/evs';

export const constant = (value: bigint) =>
  evscript({ name: 'constant' }, (s) => s.return({ value: s.lit(t.uint256, value) }))
    .compile()
    .toPrecompiled();
