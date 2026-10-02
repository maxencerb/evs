/**
 * Test setup of the `unit` and `integration` projects: a codec-sharing plan that disagrees with
 * the emitters (`CodecPlanDrift`, `src/codegen/codecs.ts`) fails the compile with an `INTERNAL`
 * error instead of silently falling back to the inline lowering, so every compile in the suite
 * checks the census against the emitters.
 */

import { setCodecPlanStrict } from '../../src/codegen/codecs.js';

setCodecPlanStrict(true);
