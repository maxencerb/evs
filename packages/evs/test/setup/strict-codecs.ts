/**
 * Test setup of the `unit` and `integration` projects, run before each test file: a
 * codec-sharing plan that disagrees with the emitters (`CodecPlanDrift`,
 * `src/codegen/codecs.ts`) fails the compile with an `INTERNAL` error instead of silently falling
 * back to the inline lowering, so every compile in the suite checks the census against the
 * emitters; strict mode also checks every plan against the exhaustive planner (the compile-time
 * shortcuts must not change a decision). It also drops any plan transform (a drift fixture) a previous file left installed:
 * the unit project shares one module instance across files (`isolate: false`).
 */

import { setCodecPlanStrict, setCodecPlanTransform } from '../../src/codegen/codecs.js';

setCodecPlanStrict(true);
setCodecPlanTransform(null);
