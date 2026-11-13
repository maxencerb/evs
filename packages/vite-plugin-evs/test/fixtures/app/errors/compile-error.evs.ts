import { evscript, t } from '@maxencerb/evs';

const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) }));

export const broken = one.compile({ evmVersion: JSON.parse('"homestead"') }).toPrecompiled();
