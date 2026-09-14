/**
 * Unit tests — `compile.ts`: artifact shape, pipeline wiring (options, diagnostics,
 * peephole), EIP-170 rejection with per-region breakdown, sites merge + sourceMap coverage,
 * `toViem()` both modes, `disassemble()` round-trip, `explainRevert` over every revert kind,
 * and the end-to-end `evscript → compile → harness` smoke.
 */

import { decodeFunctionResult, encodeErrorResult, encodeFunctionData, maxUint256 } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../test/harness/evm.js';
import { ATTACKER_RETURNERS } from '../test/harness/fixtures.js';
import { assemble, type AsmNode } from './asm/assembler.js';
import { lookupPc, siteById } from './asm/sourcemap.js';
import { evscript, type EvsScript } from './builder/script.js';
import { evsPeephole } from './codegen/peephole.js';
import { lowerProgram } from './codegen/program.js';
import { compile } from './compile.js';
import { bytesToHex } from './core/bytes.js';
import { EvsCompileError, EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import { namedArg, t, type Hex } from './core/types.js';
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
  return evscript({ name: 'sum', args: [t.uint256, t.uint256] }, (s, a, b) =>
    s.return({ total: s.add(a, b) }),
  );
}

function symbolScript() {
  return evscript({ name: 'sym', args: [] }, (s) => {
    const symbol = s.read({ address: TOKEN, abi: erc20Abi, functionName: 'symbol' });
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
    expect(compiled.options.optimize).toBe(false);
    expect(compiled.options.locations).toBe(true);
    expect(typeof compiled.options.peephole).toBe('function');
    expect(typeof compiled.options.onDiagnostic).toBe('function');
    expect(Object.isFrozen(compiled.options)).toBe(true);
  });

  test('user options are pinned on the artifact', () => {
    const compiled = compile(sumScript(), {
      evmVersion: 'paris',
      optimize: true,
      peephole: identityPeephole,
      onDiagnostic: dropDiagnostic,
      locations: false,
    });
    expect(compiled.options).toEqual({
      evmVersion: 'paris',
      optimize: true,
      peephole: identityPeephole, // the user's own hook, never the built-in composition
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
    const loopy = evscript({ name: 'loopy', args: [t.uint256] }, (s, n) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
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

  test('env caller/address emit ENV_FRAME_DEPENDENT (frame differs between toViem() modes)', () => {
    const whoami = evscript({ name: 'whoami', args: [] }, (s) =>
      s.return({ who: s.env('caller'), me: s.env('address') }),
    );
    const diags: EvsDiagnostic[] = [];
    compile(whoami, { onDiagnostic: (d) => diags.push(d) });
    const envDiags = diags.filter((d) => d.code === 'ENV_FRAME_DEPENDENT');
    expect(envDiags).toHaveLength(2);
    expect(envDiags.some((d) => d.message.includes("s.env('caller')"))).toBe(true);
    expect(envDiags.some((d) => d.message.includes("s.env('address')"))).toBe(true);
    expect(envDiags.every((d) => d.message.includes('deployless'))).toBe(true);
    expect(envDiags.every((d) => d.message.includes('stateOverride'))).toBe(true);

    // block-context env ops are mode-independent — no warning
    const blocky = evscript({ name: 'blocky', args: [] }, (s) =>
      s.return({ ts: s.env('timestamp'), chain: s.env('chainid') }),
    );
    const blockDiags: EvsDiagnostic[] = [];
    compile(blocky, { onDiagnostic: (d) => blockDiags.push(d) });
    expect(blockDiags.filter((d) => d.code === 'ENV_FRAME_DEPENDENT')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// optimize (issues #39 + #41)
// ---------------------------------------------------------------------------

/** The distinct source locations a source map carries (order-free). */
function mappedLocs(
  segments: readonly { loc: { file: string; line: number; column: number } | null }[],
): string[] {
  const keys = segments.map((s) =>
    s.loc === null ? 'null' : `${s.loc.file}:${s.loc.line}:${s.loc.column}`,
  );
  return [...new Set(keys)].toSorted();
}

/** Four dependent temporaries: one slot under the liveness allocator, four by default. */
function chainScript() {
  return evscript({ name: 'chain', args: [t.uint256, t.uint256] }, (s, a, b) => {
    const x1 = s.add(a, b);
    const x2 = s.mul(x1, b);
    const x3 = s.sub(x2, a);
    const x4 = s.add(x3, b);
    return s.return({ x4 });
  });
}

describe('optimize: the built-in passes — frame allocator (#41) + peephole (#39)', () => {
  test('optimize: true = packed-frame lowering + `evsPeephole`; the default is untouched', () => {
    const plain = compile(sumScript());
    const explicitOff = compile(sumScript(), { optimize: false });
    const optimized = compile(sumScript(), { optimize: true });
    expect(explicitOff.runtimeBytecode).toBe(plain.runtimeBytecode);
    expect(optimized.runtimeBytecode).not.toBe(plain.runtimeBytecode);
    expect(optimized.runtimeBytecode.length).toBeLessThan(plain.runtimeBytecode.length);
    // the same composition by hand: lower with the liveness frame, then the peephole pass
    const lowered = lowerProgram(sumScript().ir, {
      evmVersion: 'cancun',
      locations: true,
      optimize: true,
    });
    const byHand = assemble(lowered.nodes, {
      evmVersion: 'cancun',
      peephole: evsPeephole,
      verify: true,
    });
    expect(optimized.runtimeBytecode).toBe(bytesToHex(byHand.bytecode));
  });

  test('the frame allocator is part of `optimize`: a peephole-only hook keeps one slot per value', () => {
    const viaHook = compile(chainScript(), { peephole: evsPeephole });
    const optimized = compile(chainScript(), { optimize: true });
    expect(optimized.runtimeBytecode).not.toBe(viaHook.runtimeBytecode);
    expect(optimized.runtimeBytecode.length).toBeLessThan(viaHook.runtimeBytecode.length);
    const frameEndOf = (optimize: boolean): number =>
      lowerProgram(chainScript().ir, { evmVersion: 'cancun', locations: true, optimize }).frameEnd;
    expect(frameEndOf(false)).toBe(0x80 + 32 * 6); // 2 args + 4 temporaries
    expect(frameEndOf(true)).toBe(0x80 + 32 * 3); // 2 args + 1 shared slot
  });

  test('the user peephole hook runs AFTER the built-in pass and sees its output', () => {
    const lowered = lowerProgram(sumScript().ir, {
      evmVersion: 'cancun',
      locations: true,
      optimize: true,
    }).nodes;
    let seen: readonly AsmNode[] = [];
    const compiled = compile(sumScript(), {
      optimize: true,
      peephole: (nodes) => {
        seen = nodes;
        return [...nodes];
      },
    });
    expect(seen.length).toBe(evsPeephole(lowered).length);
    expect(seen.length).toBeLessThan(lowered.length);
    expect(compiled.runtimeBytecode).toBe(compile(sumScript(), { optimize: true }).runtimeBytecode);
  });

  test('the optimized artifact executes correctly and its source map still covers every byte', async () => {
    const compiled = compile(sumScript(), { optimize: true });
    const res = await execRuntime(compiled.runtimeBytecode, sumCalldata(2n, 3n));
    expect(res.success).toBe(true);
    expect(
      decodeFunctionResult({ abi: compiled.abi, functionName: 'sum', data: res.data }),
    ).toEqual({ total: 5n });
    const codeLen = (compiled.runtimeBytecode.length - 2) / 2;
    let lastEnd = 0;
    for (const seg of compiled.sourceMap.segments) {
      expect(seg.pc).toBe(lastEnd);
      lastEnd = seg.pc + seg.len;
    }
    expect(lastEnd).toBe(codeLen);
    for (let pc = 0; pc < codeLen; pc++) expect(lookupPc(compiled.sourceMap, pc)).toBeDefined();
  });

  test('a mapped diagnostic still resolves after optimization (locs survive the rewrite)', async () => {
    const plain = compile(sumScript());
    const optimized = compile(sumScript(), { optimize: true });
    // no statement loses its mapping: the optimized map carries exactly the same locations
    expect(mappedLocs(optimized.sourceMap.segments)).toEqual(mappedLocs(plain.sourceMap.segments));
    // the `s.add` line is still reachable through the optimized segments
    const addLoc = plain.sourceMap.sites.find((s) => s.kind === 'panic')?.loc;
    expect(addLoc).toBeDefined();
    expect(addLoc).not.toBeNull();
    const hit = optimized.sourceMap.segments.some(
      (seg) => seg.loc !== null && seg.loc.line === addLoc?.line && seg.loc.file === addLoc?.file,
    );
    expect(hit).toBe(true);
    // end to end: overflow → Panic(0x11), explained back to a candidate site in this file
    const res = await execRuntime(optimized.runtimeBytecode, sumCalldata(maxUint256, 1n));
    expect(res.success).toBe(false);
    const explained = optimized.explainRevert(res.data);
    expect(explained.kind).toBe('panic');
    expect(explained.candidateSites?.[0]?.loc?.file).toContain('compile.test.ts');
  });

  test('every fork: the optimized output passes the verifiers and is never larger', () => {
    for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
      const plain = compile(symbolScript(), { evmVersion });
      const optimized = compile(symbolScript(), { evmVersion, optimize: true });
      expect(optimized.runtimeBytecode.length).toBeLessThanOrEqual(plain.runtimeBytecode.length);
    }
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

  test('stateOverride + sender (issue #36): script AT the sender, account = sender', () => {
    const compiled = compile(sumScript());
    const sender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
    expect(compiled.toViem({ mode: 'stateOverride', sender })).toEqual({
      abi: compiled.abi,
      address: sender,
      stateOverride: [{ address: sender, code: compiled.runtimeBytecode }],
      account: sender,
    });
    // the plain stateOverride shape never carries `account` (the user composes it themselves)
    expect(compiled.toViem({ mode: 'stateOverride' })).not.toHaveProperty('account');
  });
});

// ---------------------------------------------------------------------------
// explainRevert — every kind
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

  test('evs-decode: adversarial callee selector reuse is hedged, forged sites never authoritative', async () => {
    const compiled = compile(symbolScript());
    // (a) a genuine decode failure on a script WITH sub-calls carries the off-script hedge
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: 'sym' });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TOKEN]: ATTACKER_RETURNERS.empty },
    });
    const genuine = compiled.explainRevert(res.data);
    expect(genuine.message).toMatch(/callee may have reverted with this evs selector/);
    // (b) a forged payload pointing at a NON-decode site is not presented as 'recorded at'
    const forgedSite = compiled.sourceMap.sites.find((s) => s.kind !== 'decode');
    expect(forgedSite).toBeDefined();
    const forged = compiled.explainRevert(
      encodeErrorResult({
        abi: [
          { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
        ],
        errorName: 'EvsDecodeError',
        args: [BigInt(forgedSite?.id ?? 0)],
      }),
    );
    expect(forged.kind).toBe('evs-decode');
    expect(forged.site).toBeUndefined();
    expect(forged.message).toMatch(/not a returndata-decode site/);
    expect(forged.message).not.toMatch(/recorded at/);
    // (c) a script WITHOUT sub-calls cannot bubble — its messages carry no hedge
    const pure = compile(sumScript());
    const decodePayload = encodeErrorResult({
      abi: [{ type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] }],
      errorName: 'EvsDecodeError',
      args: [999_999n],
    });
    expect(pure.explainRevert(decodePayload).message).not.toMatch(/callee may have reverted/);
  });

  test('evs-invalid-calldata: hedged only for scripts with sub-calls', async () => {
    // sumScript performs no sub-calls — the attribution is authoritative, no hedge
    const pure = compile(sumScript());
    const resPure = await execRuntime(pure.runtimeBytecode, '0x');
    const explainedPure = pure.explainRevert(resPure.data);
    expect(explainedPure.kind).toBe('evs-invalid-calldata');
    expect(explainedPure.message).not.toMatch(/callee may have reverted/);
    // symbolScript sub-calls — a callee could bubble EvsInvalidCalldata() verbatim
    const withCalls = compile(symbolScript());
    const resCalls = await execRuntime(withCalls.runtimeBytecode, '0x');
    const explainedCalls = withCalls.explainRevert(resCalls.data);
    expect(explainedCalls.kind).toBe('evs-invalid-calldata');
    expect(explainedCalls.message).toMatch(/callee may have reverted with this evs selector/);
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
    expect(() => compiled.explainRevert('0x123')).toThrowError(EvsTypeError);
  });
});

// ---------------------------------------------------------------------------
// end-to-end smoke
// ---------------------------------------------------------------------------

describe('end-to-end smoke', () => {
  test('evscript → compile → harness → viem decode', async () => {
    const script = evscript({ name: 'meta', args: [t.address, t.uint256] }, (s, who, n) => {
      const doubled = s.mul(n, 2n);
      const isBig = doubled.gt(100n);
      return s.return({ who, doubled, isBig, label: s.lit(t.string, 'evs') });
    });
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

// ---------------------------------------------------------------------------
// composite-array call args are supported (forwarding a decoded tuple[] as an arg compiles);
// the still-deferred shapes (`tuple[][]`) STILL throw UNSUPPORTED_V0.
// ---------------------------------------------------------------------------

describe('composite-array CALL ARG encode', () => {
  const posComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'liquidity', type: 'uint128' },
  ] as const;
  const abi = [
    {
      type: 'function',
      name: 'positionsBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: posComponents }],
    },
    {
      type: 'function',
      name: 'sumLiquidity',
      stateMutability: 'view',
      inputs: [{ name: 'ps', type: 'tuple[]', components: posComponents }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ] as const;
  const POOL = '0xc000000000000000000000000000000000000003' as const;

  test('forwarding a decoded tuple[] as a call arg compiles', () => {
    const script = evscript({ name: 'sumPositions' }, (s) => {
      const ps = s.read({ address: POOL, abi, functionName: 'positionsBatch', args: [2n] });
      const sum = s.read({
        address: POOL,
        abi,
        functionName: 'sumLiquidity',
        args: [ps],
      });
      return s.return({ sum });
    });
    expect(() => compile(script, { evmVersion: 'cancun' })).not.toThrow();
    const compiled = compile(script, { evmVersion: 'cancun' });
    expect(compiled.runtimeBytecode).toMatch(/^0x[0-9a-f]+$/);
  });

  test('STILL deferred: a `tuple[][]` call arg → UNSUPPORTED_V0', () => {
    const abi2 = [
      {
        type: 'function',
        name: 'twoLevels',
        stateMutability: 'view',
        inputs: [{ name: 'x', type: 'tuple[][]', components: posComponents }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ] as const;
    // the `tuple[][]` input is rejected at s.call ABI-parse time (before compile) — either way, the
    // deferred shape STILL throws UNSUPPORTED_V0.
    const err = captureError(() => {
      const script = evscript({ name: 'badTwoLevel' }, (s) => {
        const out = s.read({
          address: POOL,
          abi: abi2,
          functionName: 'twoLevels',
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deferred shape, force the gate
          args: [[] as never] as never,
        });
        return s.return({ out });
      });
      compile(script, { evmVersion: 'cancun' });
    }, EvsTypeError);
    expect(err.code).toBe('UNSUPPORTED_V0');
  });
});

// ---------------------------------------------------------------------------
// validation wiring (regression: validateIr runs once, inside lowerProgram)
// ---------------------------------------------------------------------------

describe('compile — IR validation wiring', () => {
  test('structurally invalid IR is still rejected by compile()', () => {
    const script = sumScript();
    const corrupted = structuredClone(script.ir); // the script's own ir is frozen
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- corrupting on purpose
    (corrupted.returns[0] as { value: number }).value = 999; // unknown ValueId
    const err = captureError(
      () => compile({ name: script.name, abi: script.abi, ir: corrupted }),
      Error,
    );
    expect(err.message).toContain('invalid ScriptIr');
  });
});

// ---------------------------------------------------------------------------
// custom errors — end to end on the local EVM harness (issue #15)
// ---------------------------------------------------------------------------

describe('custom errors (issue #15)', () => {
  const NoBalance = t.error('NoBalance', [
    namedArg('balance', t.uint256),
    namedArg('who', t.address),
  ]);
  const NotOwner = t.error('NotOwner');

  function throwScript() {
    return evscript(
      { name: 'guard', args: [t.uint256, t.address], errors: [NoBalance, NotOwner] },
      (s, x, who) => {
        s.if(x.lt(10n), () => {
          s.throw(NoBalance, { balance: x, who });
        });
        s.if(x.eq(999n), () => {
          s.throw(NotOwner);
        });
        return s.return({ doubled: x.mul(2n) });
      },
    );
  }

  const WHO = '0xb000000000000000000000000000000000000002' as const;
  function guardCalldata(x: bigint): Hex {
    return encodeFunctionData({ abi: throwScript().abi, functionName: 'guard', args: [x, WHO] });
  }

  test('the artifact ABI carries the declared error entries after the built-ins', () => {
    const compiled = compile(throwScript());
    const errors = compiled.abi.filter((e) => e.type === 'error').map((e) => e.name);
    expect(errors).toEqual(['EvsInvalidCalldata', 'EvsDecodeError', 'NoBalance', 'NotOwner']);
  });

  test('a with-args throw reverts with selector ‖ abi.encode(args), byte-exact vs viem', async () => {
    const compiled = compile(throwScript());
    const res = await execRuntime(compiled.runtimeBytecode, guardCalldata(5n));
    expect(res.success).toBe(false);
    expect(res.data).toBe(
      encodeErrorResult({ abi: compiled.abi, errorName: 'NoBalance', args: [5n, WHO] }),
    );
    const explained = compiled.explainRevert(res.data);
    expect(explained.kind).toBe('script-error');
    expect(explained.errorName).toBe('NoBalance');
    expect(explained.errorArgs).toEqual({ balance: 5n, who: WHO });
    expect(explained.message).toMatch(/NoBalance/);
    expect(explained.raw).toBe(res.data);
  });

  test('a zero-arg throw reverts with the bare 4-byte selector', async () => {
    const compiled = compile(throwScript());
    const res = await execRuntime(compiled.runtimeBytecode, guardCalldata(999n));
    expect(res.success).toBe(false);
    expect(res.data).toBe(encodeErrorResult({ abi: compiled.abi, errorName: 'NotOwner' }));
    expect(res.data.length).toBe(2 + 8); // selector only
    const explained = compiled.explainRevert(res.data);
    expect(explained.kind).toBe('script-error');
    expect(explained.errorName).toBe('NotOwner');
    expect(explained.errorArgs).toEqual({});
  });

  test('the success path is untouched by declared errors', async () => {
    const compiled = compile(throwScript());
    const res = await execRuntime(compiled.runtimeBytecode, guardCalldata(21n));
    expect(res.success).toBe(true);
    const decoded = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'guard',
      data: res.data,
    });
    expect(decoded).toEqual({ doubled: 42n });
  });

  test('a declared selector with a malformed payload is flagged, not decoded', () => {
    const compiled = compile(throwScript());
    const selector = compiled.ir.errors?.[0]?.selector ?? '0x';
    const explained = compiled.explainRevert(`0x${selector.slice(2)}ff`);
    expect(explained.kind).toBe('script-error');
    expect(explained.errorName).toBe('NoBalance');
    expect(explained.errorArgs).toBeUndefined();
    expect(explained.message).toMatch(/MALFORMED/);
  });

  test('a throw inside an s.fn body reverts the whole script', async () => {
    const Boom = t.error('Boom', [namedArg('x', t.uint256)]);
    const script = evscript({ name: 'fnThrow', args: [t.uint256], errors: [Boom] }, (s, x) => {
      const check = s.fn('check', t.uint256, (v) => {
        s.if(s.gt(v, 100n), () => {
          s.throw(Boom, { x: v });
        });
        return s.add(v, 1n);
      });
      return s.return({ out: check(x) });
    });
    const compiled = compile(script);
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'fnThrow', args: [500n] }),
    );
    expect(res.success).toBe(false);
    expect(res.data).toBe(
      encodeErrorResult({ abi: compiled.abi, errorName: 'Boom', args: [500n] }),
    );
  });

  test('a struct-param error encodes like Solidity (dynamic tail)', async () => {
    const Detail = t.error('Detail', [
      namedArg('info', t.struct({ code: t.uint256, note: t.string })),
    ]);
    const script = evscript({ name: 'structErr', args: [t.uint256], errors: [Detail] }, (s, x) => {
      const info = s.tuple(t.struct({ code: t.uint256, note: t.string }), {
        code: x,
        note: s.lit(t.string, 'nope'),
      });
      s.if(x.gt(0n), () => {
        s.throw(Detail, { info });
      });
      return s.return({ x });
    });
    const compiled = compile(script);
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'structErr', args: [7n] }),
    );
    expect(res.success).toBe(false);
    expect(res.data).toBe(
      encodeErrorResult({
        abi: compiled.abi,
        errorName: 'Detail',
        args: [{ code: 7n, note: 'nope' }],
      }),
    );
  });
});
