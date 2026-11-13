/**
 * The build-time module of the benchmark. With the plugin, this file runs during the build and
 * the bundle gets the script's ABI and bytecode. Without it, the same file is bundled as it is
 * and compiles in the browser.
 */
import { recordPoolMeta } from './script.ts';

export const poolMeta = recordPoolMeta().compile().toPrecompiled();
