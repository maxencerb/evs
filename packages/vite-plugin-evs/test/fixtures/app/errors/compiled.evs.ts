import { evscript, t } from '@maxencerb/evs';

export default evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) })).compile();
