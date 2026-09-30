/**
 * Revert bubbling end-to-end through viem.
 *
 * For every Reverter flavor the script's bubbled revert payload must be BYTE-IDENTICAL to
 * what the callee reverts with when called directly — the expected bytes come from calling
 * the Reverter straight (no manual encoding, no room for fixture drift).
 *
 * Plus the explainRevert() round-trip on an EvsDecodeError produced by a Malformed callee, and
 * the Malformed fixture table on a real node: every structural case reverts EvsDecodeError at
 * its own call site (strict) or reports success=false with a zero value (try); every dirty-word
 * case decodes to its normalized value — in both execution modes.
 */

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t, type CompiledEvsScript } from '../../src/index.js';
import { Malformed, Reverter } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { callExpectRevert, deploy } from './helpers.js';

/** Every Reverter flavor with the kind explainRevert must give it (and the Panic code). */
const FLAVORS = [
  ['revertErrorString', 'error-string'],
  ['revertRequire', 'error-string'],
  ['panicAssert', 'panic', 0x01n],
  ['panicOverflow', 'panic', 0x11n],
  ['panicDivZero', 'panic', 0x12n],
  ['panicArrayOob', 'panic', 0x32n],
  ['revertCustomError', 'custom'],
  ['revertCustomErrorNoArgs', 'custom'],
  ['revertEmpty', 'empty'],
] as const;

let reverter: `0x${string}`;
let malformed: `0x${string}`;

beforeAll(async () => {
  reverter = await deploy(Reverter.abi, Reverter.bytecode);
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
});

describe('revert bubbling through viem (byte-exact vs direct call)', () => {
  test.each(FLAVORS)('%s', async (flavor, kind, panicCode?: bigint) => {
    const script = evscript({ name: 'bubble', args: [t.address] }, (s, target) => {
      const v = s.read({ address: target, abi: Reverter.abi, functionName: flavor });
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

    // explainRevert classifies the real solc-produced payload exactly (never throws).
    const explained = compiled.explainRevert(bubbled);
    expect(explained.kind).toBe(kind);
    if (explained.kind === 'panic') expect(explained.panicCode).toBe(panicCode);
  });
});

describe('explainRevert round-trip on EvsDecodeError', () => {
  test('malformed string return → evs-decode with the originating call site', async () => {
    const script = evscript({ name: 'decodeFail', args: [t.address] }, (s, target) => {
      const v = s.read({ address: target, abi: Malformed.abi, functionName: 'hugeOffset' });
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
      expect(site.detail).toBe('decoding hugeOffset() returndata');
      const loc = site.loc;
      expect(loc).not.toBeNull();
      if (loc !== null) {
        expect(loc.file).toContain('revert-bubbling.test.ts');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed fixture table (attacker-shaped returndata from a real contract)
// ---------------------------------------------------------------------------

/** Structural violations, with the zero value try mode must hand back for each. */
const STRUCTURAL = [
  ['emptyReturn', ''],
  ['shortWord', 0n],
  ['hugeOffset', ''],
  ['offsetPastEnd', '0x'],
  ['hugeLength', ''],
  ['lengthPastEndByOne', '0x'],
  ['truncatedArray', []],
  ['hugeArrayLength', []],
] as const;

/** Decodable returndata: dirty words normalize, a trailing extra byte is ignored. */
const NORMALIZED = [
  ['dirtyBool', true],
  ['dirtyUint8', 255],
  ['dirtyAddress', '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF'],
  ['dirtyInt8', -128],
  ['oneByteTooLong', 42n],
] as const;

describe.each(['stateOverride', 'deployless'] as const)('Malformed fixture table [%s]', (mode) => {
  /** The eth_call target for `data` under this mode. */
  function callParams(compiled: { toViem: CompiledEvsScript['toViem'] }, data: Hex) {
    if (mode === 'deployless') return { code: compiled.toViem().code, data };
    const p = compiled.toViem({ mode: 'stateOverride' });
    return { to: p.address, stateOverride: p.stateOverride, data };
  }

  test.each(STRUCTURAL)('%s: strict → EvsDecodeError naming the call', async (fn) => {
    const compiled = evscript({ name: 'strict', args: [t.address] }, (s, target) => {
      const v = s.read({ address: target, abi: Malformed.abi, functionName: fn });
      return s.return({ v });
    }).compile();
    const raw = await callExpectRevert(
      callParams(
        compiled,
        encodeFunctionData({ abi: compiled.abi, functionName: 'strict', args: [malformed] }),
      ),
    );
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.site?.detail).toBe(`decoding ${fn}() returndata`);
    expect(explained.site?.loc?.file).toContain('revert-bubbling.test.ts');
  });

  test.each(STRUCTURAL)('%s: try → success=false and a zero value', async (fn, zero) => {
    const compiled = evscript({ name: 'attempt', args: [t.address] }, (s, target) => {
      const r = s.tryRead({ address: target, abi: Malformed.abi, functionName: fn });
      return s.return({ ok: r.success, v: r.value });
    }).compile();
    const res = await publicClient.call(
      callParams(
        compiled,
        encodeFunctionData({ abi: compiled.abi, functionName: 'attempt', args: [malformed] }),
      ),
    );
    const out = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'attempt',
      data: res.data ?? '0x',
    });
    expect(out).toEqual({ ok: false, v: zero });
  });

  test('shortHead (head one slot short): strict → EvsDecodeError naming the call', async () => {
    const compiled = evscript({ name: 'strict', args: [t.address] }, (s, target) => {
      const [a, b] = s.read({ address: target, abi: Malformed.abi, functionName: 'shortHead' });
      return s.return({ a, b });
    }).compile();
    const raw = await callExpectRevert(
      callParams(
        compiled,
        encodeFunctionData({ abi: compiled.abi, functionName: 'strict', args: [malformed] }),
      ),
    );
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.site?.detail).toBe('decoding shortHead() returndata');
  });

  test.each(NORMALIZED)('%s decodes to its normalized value', async (fn, want) => {
    const compiled = evscript({ name: 'norm', args: [t.address] }, (s, target) => {
      const v = s.read({ address: target, abi: Malformed.abi, functionName: fn });
      return s.return({ v });
    }).compile();
    const res = await publicClient.call(
      callParams(
        compiled,
        encodeFunctionData({ abi: compiled.abi, functionName: 'norm', args: [malformed] }),
      ),
    );
    const out = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'norm',
      data: res.data ?? '0x',
    });
    expect(out).toEqual({ v: want });
  });
});
