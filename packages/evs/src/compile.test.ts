/**
 * M9 unit tests — `compile.ts`: artifact shape, pipeline wiring (options, diagnostics,
 * peephole), EIP-170 rejection with per-region breakdown, sites merge + sourceMap coverage,
 * `toViem()` both modes, `disassemble()` round-trip, `explainRevert` over every revert kind,
 * and the end-to-end `evscript → compile → harness` smoke.
 */

import { decodeFunctionResult, encodeErrorResult, encodeFunctionData, maxUint256 } from 'viem';
import { describe, expect, test } from 'vitest';

import { execRuntime } from '../test/harness/evm.js';
import { ATTACKER_RETURNERS } from '../test/harness/fixtures.js';
import type { AsmNode } from './asm/assembler.js';
import { siteById } from './asm/sourcemap.js';
import { evscript, type EvsScript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsCompileError, EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import { arg, t, type Hex } from './core/types.js';
import { DEFAULT_SCRIPT_ADDRESS, toCreationBytecode } from './viem.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PANIC_ABI = [
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;
const ERROR_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
] as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

const TOKEN = '0xa000000000000000000000000000000000000001' as const;

function sumScript() {
  return evscript({ name: 'sum', args: [arg('a', t.uint256), arg('b', t.uint256)] }, (s) =>
    s.return({ total: s.add(s.args.a, s.args.b) }),
  );
}

function symbolScript() {
  return evscript({ name: 'sym', args: [] }, (s) => {
    const symbol = s.call({ address: TOKEN, abi: erc20Abi, functionName: 'symbol' });
    return s.return({ symbol });
  });
}

function sumCalldata(a: bigint, b: bigint): Hex {
  return encodeFunctionData({ abi: sumScript().abi, functionName: 'sum', args: [a, b] });
}

/** Runs `fn`, returning the thrown error narrowed to `cls` (or failing the test). */
function captureError<e extends Error>(fn: () => unknown, cls: new (...a: never[]) => e): e {
  try {
    fn();
  } catch (thrown) {
    if (thrown instanceof cls) return thrown;
    throw thrown;
  }
  return expect.unreachable('expected the callback to throw');
}

const identityPeephole = (nodes: readonly AsmNode[]): AsmNode[] => [...nodes];
const dropDiagnostic = (): void => undefined;
const mnemonicsOf = (lines: readonly { mnemonic: string }[]): string[] =>
  lines.map((l) => l.mnemonic);

// ---------------------------------------------------------------------------
// artifact shape
// ---------------------------------------------------------------------------

describe('artifact shape', () => {
  test('all pinned fields exist with the pinned semantics', () => {
    const script = sumScript();
    const compiled = compile(script);

    expect(compiled.abi).toBe(script.abi);
    expect(compiled.ir).toBe(script.ir);
    expect(compiled.runtimeBytecode).toMatch(/^0x(?:[0-9a-f]{2})+$/);
    expect(compiled.initBytecode).toBe(toCreationBytecode(compiled.runtimeBytecode, 'cancun'));
    expect(compiled.sourceMap.version).toBe(1);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect((compiled.runtimeBytecode.length - 2) / 2).toBeLessThanOrEqual(24_576);
  });

  test('options resolve to Readonly<Required<CompileOptions>> defaults', () => {
    const compiled = compile(sumScript());
    expect(compiled.options.evmVersion).toBe('cancun');
    expect(compiled.options.locations).toBe(true);
    expect(typeof compiled.options.peephole).toBe('function');
    expect(typeof compiled.options.onDiagnostic).toBe('function');
    expect(Object.isFrozen(compiled.options)).toBe(true);
  });

  test('user options are pinned on the artifact', () => {
    const compiled = compile(sumScript(), {
      evmVersion: 'paris',
      peephole: identityPeephole,
      onDiagnostic: dropDiagnostic,
      locations: false,
    });
    expect(compiled.options).toEqual({
      evmVersion: 'paris',
      peephole: identityPeephole,
      onDiagnostic: dropDiagnostic,
      locations: false,
    });
  });

  test('script.compile() sugar produces the same artifact as compile()', () => {
    const script = sumScript();
    const a = compile(script);
    const b = script.compile();
    expect(b.runtimeBytecode).toBe(a.runtimeBytecode);
    expect(b.initBytecode).toBe(a.initBytecode);
    expect(b.abi).toBe(a.abi);
  });

  test('compile rejects non-script inputs and unknown evmVersion', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => compile(42 as unknown as EvsScript)).toThrowError(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => compile(null as unknown as EvsScript)).toThrowError(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    const badVersion = 'frontier' as 'paris';
    expect(() => compile(sumScript(), { evmVersion: badVersion })).toThrowError(EvsCompileError);
    const err = captureError(
      () => compile(sumScript(), { evmVersion: badVersion }),
      EvsCompileError,
    );
    expect(err.code).toBe('EVM_VERSION');
  });
});

// ---------------------------------------------------------------------------
// evmVersion lowering surface
// ---------------------------------------------------------------------------

describe('evmVersion', () => {
  test('paris: PUSH0 never appears in the code; init wrapper uses 3D', () => {
    const paris = compile(sumScript(), { evmVersion: 'paris' });
    const cancun = compile(sumScript());
    expect(paris.initBytecode.slice(0, 22)).toMatch(/^0x61[0-9a-f]{4}80600a3d393df3$/);
    expect(cancun.initBytecode.slice(0, 22)).toMatch(/^0x61[0-9a-f]{4}80600a5f395ff3$/);
    expect(mnemonicsOf(paris.disassemble().lines)).not.toContain('PUSH0');
    expect(mnemonicsOf(cancun.disassemble().lines)).toContain('PUSH0');
  });

  test('all three versions execute the smoke script identically', async () => {
    await Promise.all(
      (['paris', 'shanghai', 'cancun'] as const).map(async (evmVersion) => {
        const compiled = compile(sumScript(), { evmVersion });
        const res = await execRuntime(compiled.runtimeBytecode, sumCalldata(2n, 40n));
        expect(res.success).toBe(true);
        const decoded = decodeFunctionResult({
          abi: compiled.abi,
          functionName: 'sum',
          data: res.data,
        });
        expect(decoded).toEqual({ total: 42n });
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// pipeline hooks
// ---------------------------------------------------------------------------

describe('pipeline hooks', () => {
  test('peephole hook runs on the node stream (default identity)', () => {
    let seenNodes = -1;
    const compiled = compile(sumScript(), {
      peephole: (nodes) => {
        seenNodes = nodes.length;
        return [...nodes];
      },
    });
    expect(seenNodes).toBeGreaterThan(0);
    expect(compiled.runtimeBytecode).toBe(compile(sumScript()).runtimeBytecode);
  });

  test('diagnostics are forwarded to onDiagnostic (LOOP_ALLOCATION), never logged', () => {
    const loopy = evscript({ name: 'loopy', args: [arg('n', t.uint256)] }, (s) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: s.args.n }, (i) => {
        const scratch = s.newArray(t.uint256, 1n);
        scratch.set(0n, i);
        acc.set(acc.get().add(scratch.get(0n)));
      });
      return s.return({ acc: acc.get() });
    });
    const diags: EvsDiagnostic[] = [];
    compile(loopy, { onDiagnostic: (d) => diags.push(d) });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.severity === 'warning')).toBe(true);
    expect(diags.some((d) => d.code === 'LOOP_ALLOCATION')).toBe(true);
    // without a callback the same compile is silent and pure
    expect(() => compile(loopy)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EIP-170
// ---------------------------------------------------------------------------

describe('EIP-170 enforcement', () => {
  test('oversized runtime → EvsCompileError(COMPILE_LIMIT) with per-region breakdown', () => {
    const big = evscript({ name: 'big', args: [] }, (s) => {
      const blob = s.lit(t.bytes, `0x${'ab'.repeat(25_000)}`);
      return s.return({ blob });
    });
    const err = captureError(() => compile(big), EvsCompileError);
    expect(err.code).toBe('COMPILE_LIMIT');
    expect(err.message).toMatch(/EIP-170 limit of 24576/);
    expect(err.message).toMatch(/dispatcher \d+, body \d+, fns \d+, tails \d+/);
    // the 25,056-byte data segment (+ INVALID guard) dominates the breakdown
    expect(err.message).toMatch(/data segments 25\d{3}/);
  });

  test('a comfortably-sized script compiles', () => {
    expect(() => compile(sumScript())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sourceMap merge + disassemble
// ---------------------------------------------------------------------------

describe('sourceMap + disassemble', () => {
  test('sites are merged into the assembler map; segments cover every byte; labels resolve', () => {
    const compiled = compile(sumScript());
    const { sourceMap } = compiled;
    expect(sourceMap.sites.length).toBeGreaterThan(0);
    for (const site of sourceMap.sites) {
      expect(siteById(sourceMap, site.id)).toBe(site);
    }
    const codeLen = (compiled.runtimeBytecode.length - 2) / 2;
    let covered = 0;
    let lastEnd = 0;
    for (const seg of sourceMap.segments) {
      expect(seg.pc).toBe(lastEnd); // sorted + gap-free
      covered += seg.len;
      lastEnd = seg.pc + seg.len;
    }
    expect(covered).toBe(codeLen);
    expect(sourceMap.labels.some((l) => l.name === 'main')).toBe(true);
  });

  test('locations: true records locs on sites; locations: false strips them', () => {
    const withLocs = compile(sumScript());
    expect(withLocs.sourceMap.sites.some((s) => s.loc !== null)).toBe(true);
    const without = compile(sumScript(), { locations: false });
    expect(without.sourceMap.sites.every((s) => s.loc === null)).toBe(true);
  });

  test('disassemble() round-trips the runtime bytes and formats with labels', () => {
    const compiled = compile(sumScript());
    const disasm = compiled.disassemble();
    const rebuilt = `0x${disasm.lines.map((l) => l.raw.slice(2)).join('')}`;
    expect(rebuilt).toBe(compiled.runtimeBytecode);
    const listing = disasm.format();
    expect(listing).toContain('JUMPDEST');
    expect(listing).toContain('@main');
  });
});

// ---------------------------------------------------------------------------
// toViem()
// ---------------------------------------------------------------------------

describe('toViem()', () => {
  test('default + explicit deployless: { abi, code: initBytecode }', () => {
    const compiled = compile(sumScript());
    expect(compiled.toViem()).toEqual({ abi: compiled.abi, code: compiled.initBytecode });
    expect(compiled.toViem({ mode: 'deployless' })).toEqual({
      abi: compiled.abi,
      code: compiled.initBytecode,
    });
    // the verified silent-failure footgun: code is NEVER the raw runtime
    expect(compiled.toViem().code).not.toBe(compiled.runtimeBytecode);
  });

  test('stateOverride: default and custom address', () => {
    const compiled = compile(sumScript());
    expect(compiled.toViem({ mode: 'stateOverride' })).toEqual({
      abi: compiled.abi,
      address: DEFAULT_SCRIPT_ADDRESS,
      stateOverride: [{ address: DEFAULT_SCRIPT_ADDRESS, code: compiled.runtimeBytecode }],
    });
    const address = '0x2000000000000000000000000000000000000002' as const;
    expect(compiled.toViem({ mode: 'stateOverride', address })).toEqual({
      abi: compiled.abi,
      address,
      stateOverride: [{ address, code: compiled.runtimeBytecode }],
    });
  });
});

// ---------------------------------------------------------------------------
// explainRevert — every kind (architecture §11/§13)
// ---------------------------------------------------------------------------

describe('explainRevert', () => {
  test('panic: code + candidateSites of that panic kind, end to end', async () => {
    const compiled = compile(sumScript());
    const res = await execRuntime(compiled.runtimeBytecode, sumCalldata(maxUint256, 1n));
    expect(res.success).toBe(false);
    expect(res.data).toBe(encodeErrorResult({ abi: PANIC_ABI, errorName: 'Panic', args: [0x11n] }));
    const explained = compiled.explainRevert(res.data);
    expect(explained.kind).toBe('panic');
    expect(explained.panicCode).toBe(0x11n);
    expect(explained.message).toMatch(/Panic\(0x11\)/);
    expect(explained.message).toMatch(/overflow/);
    expect(explained.candidateSites).toBeDefined();
    expect(explained.candidateSites?.length).toBeGreaterThan(0);
    expect(explained.candidateSites?.some((s) => s.detail.includes('add'))).toBe(true);
    expect(explained.candidateSites?.every((s) => s.loc !== null)).toBe(true);
    expect(explained.raw).toBe(res.data);
  });

  test('panic with no matching site: bubbled-from-callee wording, empty candidates', () => {
    const compiled = compile(sumScript());
    const assertPanic = encodeErrorResult({ abi: PANIC_ABI, errorName: 'Panic', args: [0x01n] });
    const explained = compiled.explainRevert(assertPanic);
    expect(explained.kind).toBe('panic');
    expect(explained.panicCode).toBe(0x01n);
    expect(explained.candidateSites).toEqual([]);
    expect(explained.message).toMatch(/bubbled verbatim from a callee/);
  });

  test('evs-decode: site id maps to the recorded call site, end to end', async () => {
    const compiled = compile(symbolScript());
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: 'sym' });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TOKEN]: ATTACKER_RETURNERS.empty },
    });
    expect(res.success).toBe(false);
    const explained = compiled.explainRevert(res.data);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.site).toBeDefined();
    expect(explained.message).toMatch(/decoding symbol\(\) returndata failed/);
    expect(explained.message).toMatch(/EvsDecodeError site \d+/);
    expect(explained.site?.detail).toContain('symbol');
    expect(siteById(compiled.sourceMap, explained.site?.id ?? -1)?.kind).toBe('decode');
  });

  test('evs-decode: unknown site id degrades gracefully', () => {
    const compiled = compile(symbolScript());
    const payload = encodeErrorResult({
      abi: [{ type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] }],
      errorName: 'EvsDecodeError',
      args: [999_999n],
    });
    const explained = compiled.explainRevert(payload);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.site).toBeUndefined();
    expect(explained.message).toMatch(/site id is unknown/);
  });

  test('evs-invalid-calldata: short calldata end to end', async () => {
    const compiled = compile(sumScript());
    const res = await execRuntime(compiled.runtimeBytecode, '0x');
    expect(res.success).toBe(false);
    const explained = compiled.explainRevert(res.data);
    expect(explained.kind).toBe('evs-invalid-calldata');
    expect(explained.message).toContain('sum(uint256,uint256)');
    expect(explained.raw).toBe(res.data);
  });

  test('error-string: decodes the reason', () => {
    const compiled = compile(sumScript());
    const payload = encodeErrorResult({ abi: ERROR_ABI, errorName: 'Error', args: ['boom'] });
    const explained = compiled.explainRevert(payload);
    expect(explained.kind).toBe('error-string');
    expect(explained.message).toContain('"boom"');
  });

  test('custom: unknown selector named in the message', () => {
    const compiled = compile(sumScript());
    const explained = compiled.explainRevert('0xdeadbeef');
    expect(explained.kind).toBe('custom');
    expect(explained.message).toContain('0xdeadbeef');
  });

  test('empty + malformed payloads', () => {
    const compiled = compile(sumScript());
    expect(compiled.explainRevert('0x').kind).toBe('empty');
    expect(compiled.explainRevert('0x4e48').kind).toBe('custom'); // truncated selector
    // Panic selector with a short body is NOT a panic
    expect(compiled.explainRevert('0x4e487b7100').kind).toBe('custom');
    // Error(string) selector with garbage body degrades to custom
    expect(compiled.explainRevert('0x08c379a0ffff').kind).toBe('custom');
    expect(() => compiled.explainRevert('0x123' as Hex)).toThrowError(EvsTypeError);
  });
});

// ---------------------------------------------------------------------------
// end-to-end smoke
// ---------------------------------------------------------------------------

describe('end-to-end smoke', () => {
  test('evscript → compile → harness → viem decode', async () => {
    const script = evscript(
      { name: 'meta', args: [arg('who', t.address), arg('n', t.uint256)] },
      (s) => {
        const doubled = s.mul(s.args.n, 2n);
        const isBig = doubled.gt(100n);
        return s.return({ who: s.args.who, doubled, isBig, label: s.lit(t.string, 'evs') });
      },
    );
    const compiled = compile(script);
    const who = '0x1000000000000000000000000000000000000001' as const;
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'meta',
      args: [who, 60n],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata);
    expect(res.success).toBe(true);
    const decoded = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'meta',
      data: res.data,
    });
    expect(decoded).toEqual({ who, doubled: 120n, isBig: true, label: 'evs' });
  });
});
