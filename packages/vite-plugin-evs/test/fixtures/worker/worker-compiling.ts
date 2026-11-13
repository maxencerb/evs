/** A worker that runs a precompiled script and compiles another at run time. */
import { evscript, t } from '@maxencerb/evs';

import { inWorker } from './worker.evs.ts';

declare function postMessage(message: unknown): void;

const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) })).compile();

postMessage([inWorker.toViem(), one.toViem()]);
