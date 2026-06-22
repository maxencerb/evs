/**
 * testing.md §3 item 4: revert bubbling end-to-end through viem.
 *
 * For every Reverter flavor the script's bubbled revert payload must be BYTE-IDENTICAL to
 * what the callee reverts with when called directly — the expected bytes come from calling
 * the Reverter straight (no manual encoding, no room for fixture drift).
 *
 * Plus the explainRevert() round-trip on an EvsDecodeError produced by a Malformed callee.
 */

import { encodeFunctionData } from 'viem';
import { beforeAll, describe, expect, test } from 'vitest';

import { evscript, t } from '../../src/index.js';
import { Malformed, Reverter } from '../generated/index.js';
import { callExpectRevert, deploy } from './helpers.js';

const FLAVORS = [
  'revertErrorString',
  'revertRequire',
  'panicAssert',
  'panicOverflow',
  'panicDivZero',
  'panicArrayOob',
  'revertCustomError',
  'revertCustomErrorNoArgs',
  'revertEmpty',
] as const;

let reverter: `0x${string}`;
let malformed: `0x${string}`;

beforeAll(async () => {
  reverter = await deploy(Reverter.abi, Reverter.bytecode);
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
});

describe('revert bubbling through viem (byte-exact vs direct call)', () => {
  test.each(FLAVORS)('%s', async (flavor) => {
    const script = evscript({ name: 'bubble', args: [t.address] }, (s, target) => {
      const v = s.call({ address: target, abi: Reverter.abi, functionName: flavor });
      return s.return({ v });
    });
    const compiled = script.compile();

    const direct = await callExpectRevert({
      to: reverter,
      data: encodeFunctionData({ abi: Reverter.abi, functionName: flavor }),
    });
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });
    const bubbled = await callExpectRevert({
      to: overrideParams.address,
      stateOverride: overrideParams.stateOverride,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'bubble', args: [reverter] }),
    });
    expect(bubbled).toBe(direct);

    // Same payload through the deployless path.
    const deploylessParams = compiled.toViem();
    const bubbledDeployless = await callExpectRevert({
      code: deploylessParams.code,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'bubble', args: [reverter] }),
    });
    expect(bubbledDeployless).toBe(direct);

    // explainRevert classifies the bubbled payload sensibly (never throws).
    const explained = compiled.explainRevert(bubbled);
    expect(['error-string', 'panic', 'custom', 'empty']).toContain(explained.kind);
  });
});

describe('explainRevert round-trip on EvsDecodeError', () => {
  test('malformed string return → evs-decode with the originating call site', async () => {
    const script = evscript({ name: 'decodeFail', args: [t.address] }, (s, target) => {
      const v = s.call({ address: target, abi: Malformed.abi, functionName: 'hugeOffset' });
      return s.return({ v });
    });
    const compiled = script.compile();

    const overrideParams = compiled.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: overrideParams.address,
      stateOverride: overrideParams.stateOverride,
      data: encodeFunctionData({
        abi: compiled.abi,
        functionName: 'decodeFail',
        args: [malformed],
      }),
    });

    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.raw).toBe(raw);
    const site = explained.site;
    expect(site).toBeDefined();
    if (site !== undefined) {
      expect(site.detail.length).toBeGreaterThan(0);
      const loc = site.loc;
      expect(loc).not.toBeNull();
      if (loc !== null) {
        expect(loc.file).toContain('revert-bubbling.test.ts');
      }
    }
  });
});
