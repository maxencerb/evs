/** Precompiles one script and compiles another behind a dynamic import. */
import { sum } from './scripts.evs.ts';

export const call = sum.toViem();

export async function compileLater() {
  const { evscript, t } = await import('@maxencerb/evs');
  return evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) })).compile();
}
