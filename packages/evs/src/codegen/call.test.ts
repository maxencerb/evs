/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these helpers narrow word-typed args (`a.type as WordType`) after an `isDyn` guard; the
 * EvsType union now includes TupleType, but these fixtures are word/dyn/array only. */
/**
 * M7 unit tests — `codegen/call.ts` (`emitStaticCall`, architecture §7/§15.2) against mock
 * callee bytecode on the M10 harness:
 *
 * - calldata template differential vs viem `encodeFunctionData` (literal / runtime / mixed
 *   args; const folding incl. the >96-byte → data-segment + CODECOPY path), observed through
 *   a calldata-reverting callee (strict mode bubbles the exact bytes back);
 * - returndata decode: success, byte-exact revert bubbling, the staticMinSize guard, the
 *   attacker payload fixtures (huge offsets/lengths, off-by-one truncation, short/empty
 *   returndata) → `EvsDecodeError(site)` with a sane gas bill, dirty-word normalization;
 * - tryCall: success flag, zeroing block defaults (word outs = 0, memrefs = empty), rejoining
 *   the program;
 * - pre-cancun memcpy path for dynamic args.
 */

import type { Abi, AbiFunction, Address } from 'abitype';
import { encodeAbiParameters, encodeErrorResult, encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vitest';

import {
  bytesToHex,
  execRuntime,
  DEFAULT_GAS_LIMIT,
  type EvmFixture,
} from '../../test/harness/evm.js';
import {
  ATTACKER_RETURNERS,
  concatHex,
  returner,
  reverter,
  word,
} from '../../test/harness/fixtures.js';
import {
  encodeLiteralData,
  encodeLiteralWord,
  selectorOf,
  toPlainAbiFunction,
} from '../abi/artifact.js';
import { AsmWriter, assemble, type LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import {
  typeToAbiParam,
  type ArrayType,
  type DynType,
  type EvsType,
  type Hex,
  type WordType,
} from '../core/types.js';
import type { Stmt } from '../ir/nodes.js';
import { emitReturnEncode, type SlotRef } from './abi.js';
import { emitStaticCall, type CallSitePlan } from './call.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// harness plumbing
// ---------------------------------------------------------------------------

const TARGET: Address = '0x00000000000000000000000000000000000000aa';
const SITE = 7;
const DECODE_ERROR: Hex = concatHex(selectorOf('EvsDecodeError', ['uint256']), word(BigInt(SITE)));

/** `RUNTIME_ECHO` with RETURN swapped for REVERT — bubbles the received calldata verbatim. */
const CALLDATA_REVERTER: Hex = '0x365f5f37365ffd';

const isDyn = (type: EvsType): type is DynType | ArrayType =>
  typeof type === 'string' && (type === 'string' || type === 'bytes' || type.endsWith('[]'));

interface ArgCfg {
  type: EvsType;
  value: unknown;
  via: 'literal' | 'runtime';
}

interface CallCfg {
  evmVersion: EvmVersion;
  fnName: string;
  args: readonly ArgCfg[];
  outs: readonly EvsType[];
  mode: 'strict' | 'try';
  target?: 'literal' | 'slot';
  gas?: { via: 'literal' | 'slot'; value: bigint };
}

interface BuiltCall {
  runtime: Hex;
  dataSegCount: number;
  fnItem: AbiFunction;
}

/**
 * prologue → preload runtime operands into frame slots / heap memrefs → `emitStaticCall` →
 * `emitReturnEncode` of `[success?, ...outs]` → dfail stub (strict) → shared tails → data
 * segments last.
 */
function buildCallRuntime(cfg: CallCfg): BuiltCall {
  const { evmVersion } = cfg;
  const w = new AsmWriter();

  // frame layout
  const targetSlot = 0x80;
  const gasSlot = 0xa0;
  const argBase = 0xc0;
  const argSlots = cfg.args.map((_, i) => argBase + 32 * i);
  const outBase = argBase + 32 * cfg.args.length;
  const outSlots = cfg.outs.map((_, j) => outBase + 32 * j);
  const successSlot = outBase + 32 * cfg.outs.length;
  const frameEnd = successSlot + 32;

  w.push(frameEnd);
  w.push(0x40);
  w.op('MSTORE');
  const tails = createSharedTails(w, { evmVersion });
  let alloc = frameEnd;

  const storeWord = (slot: number, hex: Hex): void => {
    w.push(BigInt(hex));
    w.push(slot);
    w.op('MSTORE');
  };
  /** Writes a `[len][payload…]` image on the heap, points `slot` at it, bumps 0x40. */
  const storeMemref = (slot: number, dataHex: Hex): void => {
    const body = dataHex.slice(2);
    for (let k = 0; k * 64 < body.length; k++) {
      w.push(BigInt(`0x${body.slice(64 * k, 64 * k + 64)}`));
      w.push(alloc + 32 * k);
      w.op('MSTORE');
    }
    w.push(alloc);
    w.push(slot);
    w.op('MSTORE');
    alloc += body.length / 2;
    w.push(alloc);
    w.push(0x40);
    w.op('MSTORE');
  };

  const targetWord = encodeLiteralWord('address', TARGET);
  const targetMode = cfg.target ?? 'literal';
  if (targetMode === 'slot') storeWord(targetSlot, targetWord);
  if (cfg.gas !== undefined && cfg.gas.via === 'slot') {
    storeWord(gasSlot, encodeLiteralWord('uint256', cfg.gas.value));
  }

  const argRefs = cfg.args.map((a, i): CallSitePlan['argRefs'][number] => {
    if (a.via === 'literal') {
      return isDyn(a.type)
        ? { literal: { kind: 'data', hex: encodeLiteralData(a.type, a.value) } }
        : { literal: { kind: 'word', hex: encodeLiteralWord(a.type as WordType, a.value) } };
    }
    const slot = argSlots[i];
    if (slot === undefined) throw new Error('unreachable');
    if (isDyn(a.type)) {
      storeMemref(slot, encodeLiteralData(a.type, a.value));
    } else {
      storeWord(slot, encodeLiteralWord(a.type as WordType, a.value));
    }
    return { slot, type: a.type };
  });

  const fnItem: AbiFunction = {
    type: 'function',
    name: cfg.fnName,
    stateMutability: 'view',
    inputs: cfg.args.map((a, i) => typeToAbiParam(`a${i}`, a.type)),
    outputs: cfg.outs.map((type, j) => typeToAbiParam(`o${j}`, type)),
  };
  const fnAbi = toPlainAbiFunction(fnItem);

  const base = { k: 'call' as const, loc: null, site: SITE, target: 0, fnAbi, args: [], outs: [] };
  const stmt: Extract<Stmt, { k: 'call' }> =
    cfg.mode === 'try' ? { ...base, mode: 'try', successOut: 0 } : { ...base, mode: 'strict' };

  const successRef: SlotRef | null =
    cfg.mode === 'try' ? { slot: successSlot, type: 'bool' } : null;
  const dfail = w.newLabel(`dfail_${SITE}`);
  const outRefs = cfg.outs.map((type, j) => {
    const slot = outSlots[j];
    if (slot === undefined) throw new Error('unreachable');
    return { slot, type };
  });

  const plan: CallSitePlan = {
    stmt,
    targetRef:
      targetMode === 'slot'
        ? { slot: targetSlot, type: 'address' }
        : { literal: { kind: 'word', hex: targetWord } },
    ...(cfg.gas === undefined
      ? {}
      : {
          gasRef:
            cfg.gas.via === 'slot'
              ? { slot: gasSlot, type: 'uint256' as const }
              : {
                  literal: {
                    kind: 'word' as const,
                    hex: encodeLiteralWord('uint256', cfg.gas.value),
                  },
                },
        }),
    argRefs,
    outRefs,
    successRef,
    dfailLabel: dfail,
    siteId: SITE,
  };

  const segs: { label: LabelId; bytes: Uint8Array }[] = [];
  const dataSeg = (bytes: Uint8Array): LabelId => {
    const label = w.newLabel(`dataseg_${segs.length}`);
    segs.push({ label, bytes });
    return label;
  };

  emitStaticCall(w, plan, tails, { evmVersion }, dataSeg);

  const comps: { name: string; ref: SlotRef }[] = [];
  if (successRef !== null) comps.push({ name: 'ok', ref: successRef });
  outRefs.forEach((ref, j) => comps.push({ name: `o${j}`, ref }));
  emitReturnEncode(w, comps, tails, { evmVersion });

  if (cfg.mode === 'strict') emitDecodeFailStub(w, dfail, SITE, tails);
  emitSharedTails(w, tails, { evmVersion });
  for (const s of segs) {
    w.dataLabel(s.label);
    w.data(s.bytes);
  }

  return {
    runtime: bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode),
    dataSegCount: segs.length,
    fnItem,
  };
}

function fixtureWith(calleeRuntime: Hex): EvmFixture {
  return { contracts: { [TARGET]: calleeRuntime } };
}

function expectedCalldata(fnItem: AbiFunction, args: readonly unknown[]): Hex {
  const abi: Abi = [fnItem];
  return encodeFunctionData({ abi, functionName: fnItem.name, args });
}

/** ABI-encode the observation tuple the test runtimes RETURN. */
function tuple(
  comps: readonly { name: string; type: string }[],
  values: Record<string, unknown>,
): Hex {
  return encodeAbiParameters(
    [{ type: 'tuple', components: comps.map((c) => ({ name: c.name, type: c.type })) }],
    [values],
  );
}

function outComps(
  outs: readonly EvsType[],
  withSuccess: boolean,
): { name: string; type: string; components?: readonly unknown[] }[] {
  const comps: { name: string; type: string; components?: readonly unknown[] }[] = [];
  if (withSuccess) comps.push({ name: 'ok', type: 'bool' });
  outs.forEach((type, j) => comps.push(typeToAbiParam(`o${j}`, type)));
  return comps;
}

// ---------------------------------------------------------------------------
// calldata template differential vs viem encodeFunctionData (§7.1)
// ---------------------------------------------------------------------------

describe('calldata template vs viem encodeFunctionData (bubbled through a calldata-reverter)', () => {
  interface TemplateCase {
    name: string;
    args: readonly ArgCfg[];
    expectDataSegs: number;
    forks?: readonly EvmVersion[];
  }
  const ADDR = '0x1111111111111111111111111111111111111111';
  const CASES: readonly TemplateCase[] = [
    { name: 'zero args (selector-only const segment)', args: [], expectDataSegs: 0 },
    {
      name: 'all-literal words ≤ 96 bytes merge into one inline const segment',
      args: [
        { type: 'address', value: ADDR, via: 'literal' },
        { type: 'uint256', value: 123456789n, via: 'literal' },
      ],
      expectDataSegs: 0,
    },
    {
      name: 'all-literal words > 96 bytes collapse to one data segment (4+96=100B)',
      args: [
        { type: 'address', value: ADDR, via: 'literal' },
        { type: 'uint256', value: 123456789n, via: 'literal' },
        { type: 'bool', value: true, via: 'literal' },
      ],
      expectDataSegs: 1,
    },
    {
      name: 'runtime words slot into const heads',
      args: [
        { type: 'address', value: ADDR, via: 'literal' },
        { type: 'uint256', value: 42n, via: 'runtime' },
        { type: 'int24', value: -5n, via: 'runtime' },
        { type: 'bytes4', value: '0xdeadbeef', via: 'literal' },
      ],
      expectDataSegs: 0,
    },
    {
      name: 'small literal dynamic arg stays inline (static regime)',
      args: [
        { type: 'string', value: 'hi', via: 'literal' },
        { type: 'uint256', value: 1n, via: 'runtime' },
      ],
      expectDataSegs: 0,
    },
    {
      name: 'all-literal call > 96 bytes collapses to one data segment + CODECOPY',
      args: [{ type: 'bytes', value: `0x${'ab'.repeat(120)}`, via: 'literal' }],
      expectDataSegs: 1,
    },
    {
      name: 'runtime dynamic args (dynamic regime, memcpy path)',
      args: [
        { type: 'string', value: 'runtime tail', via: 'runtime' },
        { type: 'uint256', value: 7n, via: 'runtime' },
        { type: 'uint256[]', value: [1n, 2n, 3n], via: 'runtime' },
      ],
      expectDataSegs: 0,
      forks: ['cancun', 'shanghai', 'paris'],
    },
    {
      name: 'literal + runtime dynamics interleaved (dynamic regime)',
      args: [
        { type: 'bytes', value: '0x0102030405', via: 'literal' },
        { type: 'string', value: 'mix', via: 'runtime' },
        { type: 'address', value: ADDR, via: 'literal' },
      ],
      expectDataSegs: 0,
      forks: ['cancun', 'paris'],
    },
    {
      name: 'big literal tail in the dynamic regime goes to a data segment',
      args: [
        { type: 'bytes', value: `0x${'cd'.repeat(150)}`, via: 'literal' },
        { type: 'string', value: 'rt', via: 'runtime' },
      ],
      expectDataSegs: 1,
      forks: ['cancun', 'paris'],
    },
    {
      name: 'empty runtime dynamics',
      args: [
        { type: 'string', value: '', via: 'runtime' },
        { type: 'uint256[]', value: [], via: 'runtime' },
      ],
      expectDataSegs: 0,
      forks: ['cancun', 'paris'],
    },
  ];

  for (const c of CASES) {
    for (const evmVersion of c.forks ?? (['cancun'] as const)) {
      test(`${c.name} (${evmVersion})`, async () => {
        const built = buildCallRuntime({
          evmVersion,
          fnName: 'probe',
          args: c.args,
          outs: [],
          mode: 'strict',
        });
        expect(built.dataSegCount).toBe(c.expectDataSegs);
        const res = await execRuntime(built.runtime, '0x', fixtureWith(CALLDATA_REVERTER));
        expect(res.success).toBe(false); // the reverter bubbles the calldata back
        expect(res.data).toBe(
          expectedCalldata(
            built.fnItem,
            c.args.map((a) => a.value),
          ),
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// returndata decode — success paths
// ---------------------------------------------------------------------------

describe('strict decode success paths', () => {
  test('zero-output call: no guard, no snapshot, rejoins', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'poke',
      args: [],
      outs: [],
      mode: 'strict',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner('0x')));
    expect(res.success).toBe(true);
    expect(res.data).toBe('0x'); // empty observation tuple
  });

  test('dynamic outputs decode in place (string + uint256[])', async () => {
    const outs: readonly EvsType[] = ['string', 'uint256[]'];
    const payload = encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256[]' }],
      ['WETH', [1n, 2n, 3n]],
    );
    const results = await Promise.all(
      (['cancun', 'paris'] as const).map((evmVersion) => {
        const built = buildCallRuntime({
          evmVersion,
          fnName: 'meta',
          args: [],
          outs,
          mode: 'strict',
        });
        return execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
      }),
    );
    for (const res of results) {
      expect(res.success).toBe(true);
      expect(res.data).toBe(tuple(outComps(outs, false), { o0: 'WETH', o1: [1n, 2n, 3n] }));
    }
  });

  test('word outputs normalize dirty high bits instead of reverting', async () => {
    const outs: readonly EvsType[] = ['uint8', 'address', 'bool', 'bytes4'];
    const payload = concatHex(word(-1n), word(-1n), word(-1n), word(-1n));
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'dirty',
      args: [],
      outs,
      mode: 'strict',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tuple(outComps(outs, false), {
        o0: 255,
        o1: '0xffffffffffffffffffffffffffffffffffffffff',
        o2: true,
        o3: '0xffffffff',
      }),
    );
  });

  test('single dirty word output (uint8) — the research fixture', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'one',
      args: [],
      outs: ['uint8'],
      mode: 'strict',
    });
    const res = await execRuntime(
      built.runtime,
      '0x',
      fixtureWith(ATTACKER_RETURNERS.dirtyHighBits),
    );
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(['uint8'], false), { o0: 255 }));
  });

  test('array outputs normalize elements eagerly (bool[] with element word 5)', async () => {
    const payload = concatHex(word(32n), word(2n), word(5n), word(0n));
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'flags',
      args: [],
      outs: ['bool[]'],
      mode: 'strict',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(['bool[]'], false), { o0: [true, false] }));
  });

  test('byte-exact minimal returndata accepted (off-by-one boundary, len 5, rds 69)', async () => {
    const payload = concatHex(word(32n), word(5n), '0x68656c6c6f');
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'sym',
      args: [],
      outs: ['string'],
      mode: 'strict',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(['string'], false), { o0: 'hello' }));
  });

  test('gas cap operand: literal and slot variants still succeed', async () => {
    const payload = word(42n);
    const results = await Promise.all(
      (['literal', 'slot'] as const).map((via) => {
        const built = buildCallRuntime({
          evmVersion: 'cancun',
          fnName: 'gassy',
          args: [],
          outs: ['uint256'],
          mode: 'strict',
          gas: { via, value: 200_000n },
        });
        return execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
      }),
    );
    for (const res of results) {
      expect(res.success).toBe(true);
      expect(res.data).toBe(tuple(outComps(['uint256'], false), { o0: 42n }));
    }
  });

  test('target address from a frame slot', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'slotted',
      args: [],
      outs: ['uint256'],
      mode: 'strict',
      target: 'slot',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(word(9n))));
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(['uint256'], false), { o0: 9n }));
  });
});

// ---------------------------------------------------------------------------
// strict failure: verbatim revert bubbling + tiny gas cap
// ---------------------------------------------------------------------------

describe('strict STATICCALL failure bubbles the callee revert verbatim', () => {
  const BUBBLES: readonly { name: string; payload: Hex }[] = [
    {
      name: 'Error(string)',
      payload: encodeErrorResult({
        abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }] as Abi,
        errorName: 'Error',
        args: ['nope'],
      }),
    },
    { name: 'Panic(0x11)', payload: concatHex('0x4e487b71', word(0x11n)) },
    { name: 'custom error', payload: concatHex('0xdeadbeef', word(1n)) },
    { name: 'empty revert', payload: '0x' },
  ];
  for (const b of BUBBLES) {
    test(`bubbles ${b.name}`, async () => {
      const built = buildCallRuntime({
        evmVersion: 'cancun',
        fnName: 'boom',
        args: [],
        outs: ['uint256'],
        mode: 'strict',
      });
      const res = await execRuntime(built.runtime, '0x', fixtureWith(reverter(b.payload)));
      expect(res.success).toBe(false);
      expect(res.data).toBe(b.payload); // byte-exact
    });
  }

  test('a starved gas cap fails the call and bubbles the empty OOG revert', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'starved',
      args: [],
      outs: ['uint256'],
      mode: 'strict',
      gas: { via: 'literal', value: 5n },
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(word(1n))));
    expect(res.success).toBe(false);
    expect(res.data).toBe('0x');
  });
});

// ---------------------------------------------------------------------------
// attacker payload fixtures → EvsDecodeError(site), never garbage (testing.md §2)
// ---------------------------------------------------------------------------

describe('malformed returndata → EvsDecodeError(site) — strict mode', () => {
  const MALFORMED: readonly { name: string; callee: Hex; outs: readonly EvsType[] }[] = [
    { name: 'empty returndata, word output', callee: ATTACKER_RETURNERS.empty, outs: ['uint256'] },
    {
      name: 'empty returndata, dynamic output',
      callee: ATTACKER_RETURNERS.empty,
      outs: ['string'],
    },
    { name: 'short word (31 bytes)', callee: ATTACKER_RETURNERS.shortWord, outs: ['uint256'] },
    {
      name: 'huge head offset (2^255)',
      callee: ATTACKER_RETURNERS.hugeHeadOffset,
      outs: ['string'],
    },
    { name: 'huge length (2^200)', callee: ATTACKER_RETURNERS.hugeLength, outs: ['bytes'] },
    {
      name: 'off-by-one truncated tail',
      callee: ATTACKER_RETURNERS.offByOneTruncation,
      outs: ['bytes'],
    },
    {
      name: 'huge length against an array output',
      callee: ATTACKER_RETURNERS.hugeLength,
      outs: ['uint256[]'],
    },
    {
      name: 'head shorter than 32·nOutputs (1 word for 2 outputs)',
      callee: returner(word(1n)),
      outs: ['uint256', 'uint256'],
    },
    {
      name: 'array claims more elements than returned',
      callee: returner(concatHex(word(32n), word(3n), word(1n), word(2n))),
      outs: ['uint256[]'],
    },
    {
      name: 'EOA target (success with zero returndata)',
      callee: '0x', // planted empty — same as calling a codeless account
      outs: ['uint256'],
    },
  ];
  for (const m of MALFORMED) {
    test(`rejects ${m.name}`, async () => {
      const built = buildCallRuntime({
        evmVersion: 'cancun',
        fnName: 'victim',
        args: [],
        outs: m.outs,
        mode: 'strict',
      });
      const fixture = m.callee === '0x' ? undefined : fixtureWith(m.callee);
      const res = await execRuntime(built.runtime, '0x', fixture);
      expect(res.success).toBe(false);
      expect(res.data).toBe(DECODE_ERROR); // EvsDecodeError(site) — the law-specified shape
      expect(res.gasUsed).toBeLessThan(DEFAULT_GAS_LIMIT / 100n); // never an all-gas OOB halt
    });
  }
});

// ---------------------------------------------------------------------------
// tryCall — success flag, zeroing block, rejoining
// ---------------------------------------------------------------------------

describe('tryCall (architecture §7.2 step 6)', () => {
  const OUTS: readonly EvsType[] = ['uint256', 'string'];
  const COMPS = outComps(OUTS, true);
  const ZEROED = tuple(COMPS, { ok: false, o0: 0n, o1: '' });

  test('success: flag set, outputs decoded', async () => {
    const payload = encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [77n, 'ok!']);
    const results = await Promise.all(
      (['cancun', 'paris'] as const).map((evmVersion) => {
        const built = buildCallRuntime({
          evmVersion,
          fnName: 'maybe',
          args: [],
          outs: OUTS,
          mode: 'try',
        });
        return execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
      }),
    );
    for (const res of results) {
      expect(res.success).toBe(true);
      expect(res.data).toBe(tuple(COMPS, { ok: true, o0: 77n, o1: 'ok!' }));
    }
  });

  test('callee revert: success=false, outs zeroed, execution continues', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'maybe',
      args: [],
      outs: OUTS,
      mode: 'try',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(reverter('0xdeadbeef')));
    expect(res.success).toBe(true); // the SCRIPT returns fine
    expect(res.data).toBe(ZEROED);
  });

  for (const [name, callee] of [
    ['empty returndata', ATTACKER_RETURNERS.empty],
    ['huge head offset', ATTACKER_RETURNERS.hugeHeadOffset],
    ['huge length', ATTACKER_RETURNERS.hugeLength],
    ['off-by-one truncation', ATTACKER_RETURNERS.offByOneTruncation],
  ] as const) {
    test(`malformed returndata (${name}): success=false, zeroed, rejoins`, async () => {
      const built = buildCallRuntime({
        evmVersion: 'cancun',
        fnName: 'maybe',
        args: [],
        outs: OUTS,
        mode: 'try',
      });
      const res = await execRuntime(built.runtime, '0x', fixtureWith(callee));
      expect(res.success).toBe(true);
      expect(res.data).toBe(ZEROED);
      expect(res.gasUsed).toBeLessThan(DEFAULT_GAS_LIMIT / 100n);
    });
  }

  test('memref/array outs zero to the 0x60 slot (empty values)', async () => {
    const outs: readonly EvsType[] = ['uint256[]', 'bytes', 'bool'];
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'maybe',
      args: [],
      outs,
      mode: 'try',
    });
    const res = await execRuntime(built.runtime, '0x', fixtureWith(reverter('0x')));
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(outs, true), { ok: false, o0: [], o1: '0x', o2: false }));
  });

  test('zero-output try call against an EOA-shaped target succeeds (empty call is fine)', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'ping',
      args: [],
      outs: [],
      mode: 'try',
    });
    const res = await execRuntime(built.runtime, '0x'); // no code planted at TARGET
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps([], true), { ok: true }));
  });

  test('with outputs, an EOA-shaped target zeroes via the staticMinSize guard', async () => {
    const built = buildCallRuntime({
      evmVersion: 'cancun',
      fnName: 'meta',
      args: [],
      outs: OUTS,
      mode: 'try',
    });
    const res = await execRuntime(built.runtime, '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe(ZEROED);
  });

  test('try call with runtime dynamic args (dynamic regime + zero block, paris)', async () => {
    const built = buildCallRuntime({
      evmVersion: 'paris',
      fnName: 'maybe',
      args: [{ type: 'string', value: 'q', via: 'runtime' }],
      outs: ['uint256'],
      mode: 'try',
    });
    const payload = word(5n);
    const res = await execRuntime(built.runtime, '0x', fixtureWith(returner(payload)));
    expect(res.success).toBe(true);
    expect(res.data).toBe(tuple(outComps(['uint256'], true), { ok: true, o0: 5n }));
  });
});
