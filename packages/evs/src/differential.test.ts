/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * M9 differential suite — the anti-miscompilation core (testing.md §4.1).
 *
 * For a corpus of builder scripts covering every op family, control flow, calls with mocks,
 * tryCall, and dynamic returns, `interpret(script.ir, args, mockChain)` must agree
 * BYTE-FOR-BYTE with `execRuntime(compile(script).runtimeBytecode, calldata, fixture)` on
 * both returndata and revert payloads (Panic codes, EvsDecodeError site ids, bubbled callee
 * reverts, tryCall zeroing). The mock chain and the harness fixtures are generated from the
 * same callee table so both sides see identical callee behavior; the `Reverter` case uses
 * the REAL solc artifact on the EVM side against independently ABI-encoded payloads on the
 * interpreter side.
 */

import type { Abi, Address } from 'abitype';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
} from 'viem';
import { describe, expect, test } from 'vitest';

import { Reverter } from '../test/generated/index.js';
import {
  CALLER_ADDRESS,
  DEPLOYLESS_WRAPPER_ADDRESS,
  execRuntime,
  execRuntimeDeployless,
  hexToBytes,
  SCRIPT_ADDRESS,
  type EvmFixture,
} from '../test/harness/evm.js';
import { concatHex, returner, reverter, RUNTIME_ECHO, word } from '../test/harness/fixtures.js';
import { assemble, AsmWriter, type LabelId } from './asm/assembler.js';
import type { EvmVersion } from './asm/ops.js';
import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript } from './compile.js';
import { arg, t, type Hex, type NumericType } from './core/types.js';
import { interpret, type MockChain } from './ir/interp.js';
import type { ScriptIr } from './ir/nodes.js';

// ---------------------------------------------------------------------------
// shared callee table → (MockChain, EvmFixture) — testing.md §4.1's "same table"
// ---------------------------------------------------------------------------

type CalleeCase = { selector: Hex; kind: 'return' | 'revert'; data: Hex };
type CalleeBehavior =
  | { kind: 'return' | 'revert'; data: Hex } // fixed payload, any calldata
  | { kind: 'dispatch'; cases: readonly CalleeCase[] } // route on selector
  | { kind: 'echo' } // returns calldata verbatim
  | { kind: 'bytecode'; runtime: Hex; respond: (calldata: Hex) => { success: boolean; data: Hex } };
/** Keys MUST be lowercase 0x addresses (the interpreter reports `to` lowercased). */
type CalleeTable = Readonly<Record<string, CalleeBehavior>>;

function chainOf(table: CalleeTable): MockChain {
  return {
    staticcall({ to, data }) {
      const entry = table[to.toLowerCase()];
      // unmocked account: a real STATICCALL to code-less address SUCCEEDS with empty returndata
      if (entry === undefined) return { success: true, data: '0x' };
      switch (entry.kind) {
        case 'return':
          return { success: true, data: entry.data };
        case 'revert':
          return { success: false, data: entry.data };
        case 'echo':
          return { success: true, data };
        case 'dispatch': {
          const sel = data.slice(0, 10).toLowerCase();
          const hit = entry.cases.find((c) => c.selector.toLowerCase() === sel);
          if (hit === undefined) return { success: false, data: '0x' };
          return { success: hit.kind === 'return', data: hit.data };
        }
        default:
          return entry.respond(data);
      }
    },
  };
}

function fixtureOf(table: CalleeTable): EvmFixture {
  const contracts: Record<Address, Hex> = {};
  const runtimeOf = (entry: CalleeBehavior): Hex => {
    switch (entry.kind) {
      case 'return':
        return returner(entry.data);
      case 'revert':
        return reverter(entry.data);
      case 'echo':
        return RUNTIME_ECHO;
      case 'dispatch':
        return dispatcherMock(entry.cases);
      default:
        return entry.runtime;
    }
  };
  for (const [address, entry] of Object.entries(table)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- table keys are addresses
    contracts[address as Address] = runtimeOf(entry);
  }
  return { contracts };
}

/** Selector-routing mock runtime, assembled with the project's own (verified) assembler. */
function dispatcherMock(cases: readonly CalleeCase[]): Hex {
  const w = new AsmWriter();
  w.push(0);
  w.op('CALLDATALOAD');
  w.push(0xe0);
  w.op('SHR'); // [sel]
  const caseLabels: LabelId[] = cases.map((_, i) => w.newLabel(`case_${i}`));
  cases.forEach((c, i) => {
    w.op('DUP1');
    w.pushBytes(hexToBytes(c.selector));
    w.op('EQ');
    w.pushLabel(caseLabels[i] ?? 0);
    w.op('JUMPI');
  });
  w.push(0);
  w.push(0);
  w.op('REVERT'); // unknown selector
  const payloads: { label: LabelId; bytes: Uint8Array }[] = [];
  cases.forEach((c, i) => {
    w.label(caseLabels[i] ?? 0, 1); // [sel]
    const bytes = hexToBytes(c.data);
    if (bytes.length === 0) {
      w.push(0);
      w.push(0);
    } else {
      const dl = w.newLabel(`payload_${i}`);
      payloads.push({ label: dl, bytes });
      w.push(bytes.length); // [len, sel]
      w.op('DUP1'); // [len, len, sel]
      w.pushLabel(dl); // [off, len, len, sel]
      w.push(0); // [0, off, len, len, sel]
      w.op('CODECOPY'); // [len, sel]
      w.push(0); // [0, len, sel]
    }
    w.op(c.kind === 'return' ? 'RETURN' : 'REVERT');
  });
  for (const p of payloads) {
    w.dataLabel(p.label);
    w.data(p.bytes);
  }
  const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
  let hex = '';
  for (const b of bytecode) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

// ---------------------------------------------------------------------------
// the differential runner
// ---------------------------------------------------------------------------

interface AnyScript {
  readonly name: string;
  readonly ir: ScriptIr;
  readonly abi: readonly unknown[];
}

type Outcome = { kind: 'return' | 'revert'; data: Hex };

/**
 * Compiles once, then for every arg set asserts byte-exact agreement between the reference
 * interpreter and the compiled runtime on the harness EVM. Returns the (agreed) outcomes so
 * callers can pin expectations for specific cases.
 */
async function expectAgreement(
  script: AnyScript,
  argSets: readonly (readonly unknown[])[],
  table: CalleeTable = {},
  evmVersion: EvmVersion = 'cancun',
): Promise<Outcome[]> {
  const compiled: CompiledEvsScript = compile(script, { evmVersion });
  const fixture = fixtureOf(table);
  const chain = chainOf(table);
  const outcomes: Outcome[] = [];
  for (const args of argSets) {
    const label = `${script.name}(${args.map(String).join(', ')}) [${evmVersion}]`;
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: script.name, args });
    const fromInterp = interpret(script.ir, args, chain).outcome;
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: deterministic per-case labels
    const fromEvm = await execRuntime(compiled.runtimeBytecode, calldata, fixture);
    expect(fromEvm.success, `${label}: interp outcome is '${fromInterp.kind}'`).toBe(
      fromInterp.kind === 'return',
    );
    expect(fromEvm.data, `${label}: payload`).toBe(fromInterp.data);
    // decode/panic reverts must never be exceptional halts (no all-gas consumption)
    expect(fromEvm.gasUsed, `${label}: gas sanity`).toBeLessThan(25_000_000n);
    outcomes.push({ kind: fromInterp.kind, data: fromInterp.data });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// shared constants
// ---------------------------------------------------------------------------

const PANIC_ABI = [
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;
const ERROR_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
] as const;
const panicData = (code: bigint): Hex =>
  encodeErrorResult({ abi: PANIC_ABI, errorName: 'Panic', args: [code] });

const TOKA = '0xa000000000000000000000000000000000000001';
const TOKB = '0xb000000000000000000000000000000000000002';
const POOL = '0xc000000000000000000000000000000000000003';
const REVERTER = '0xd000000000000000000000000000000000000004';
const ECHO = '0xe000000000000000000000000000000000000005';
const DEAD = '0xdead00000000000000000000000000000000dead';
const USER = '0x1000000000000000000000000000000000000001';

const erc20ishAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'flag',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'tick',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int24' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'list',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multi',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'a', type: 'uint160' },
      { name: 'b', type: 'int24' },
      { name: 'c', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'mix',
    stateMutability: 'view',
    inputs: [
      { name: 'v', type: 'uint256' },
      { name: 'who', type: 'address' },
      { name: 'payload', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
    ],
  },
] as const satisfies Abi;

const sel = (signature: string): Hex => toFunctionSelector(signature);

// ---------------------------------------------------------------------------
// 1. checked arithmetic — every width class × {add,sub,mul,div,mod} over boundary operands
// ---------------------------------------------------------------------------

type BinOpName = 'add' | 'sub' | 'mul' | 'div' | 'mod';
const BIN_OPS: readonly BinOpName[] = ['add', 'sub', 'mul', 'div', 'mod'];
const WIDTHS: readonly NumericType[] = [
  'uint8',
  'uint64',
  'uint192',
  'uint256',
  'int8',
  'int200',
  'int256',
];

function binScript(type: NumericType, op: BinOpName) {
  return evscript({ name: `bin_${op}`, args: [type, type] }, (s, a, b) => {
    const r =
      op === 'add'
        ? s.add(a, b)
        : op === 'sub'
          ? s.sub(a, b)
          : op === 'mul'
            ? s.mul(a, b)
            : op === 'div'
              ? s.div(a, b)
              : s.mod(a, b);
    return s.return({ r });
  });
}

function rangeOf(type: NumericType): { min: bigint; max: bigint } {
  const signed = type.startsWith('int');
  const bits = BigInt(signed ? type.slice(3) : type.slice(4));
  return signed
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n }
    : { min: 0n, max: (1n << bits) - 1n };
}

function operandPairs(type: NumericType): readonly (readonly [bigint, bigint])[] {
  const { min, max } = rangeOf(type);
  const pairs: (readonly [bigint, bigint])[] = [
    [0n, 0n], // div/mod by zero
    [0n, 1n],
    [1n, 0n], // div/mod by zero
    [2n, 3n], // uint sub underflow
    [3n, 2n],
    [max, 1n], // add overflow
    [max - 1n, 1n],
    [max, max], // mul overflow
    [min, 1n],
  ];
  if (min < 0n) {
    pairs.push([min, -1n], [-1n, min], [min, max], [-5n, 3n], [3n, -5n], [-7n, -3n]);
  }
  if (type === 'uint192') pairs.push([1n << 191n, (1n << 65n) + 1n]); // 256-bit wrap-back
  if (type === 'int200') pairs.push([1n << 150n, 1n << 60n]); // > int200 max, < 2^255
  return pairs;
}

describe('checked arithmetic (boundary matrix)', () => {
  for (const type of WIDTHS) {
    for (const op of BIN_OPS) {
      test(`${op} ${type}`, async () => {
        await expectAgreement(binScript(type, op), operandPairs(type));
      });
    }
  }

  test('uint192 mul wrap-past-2^256 panics 0x11 on both sides (pinned)', async () => {
    const [o] = await expectAgreement(binScript('uint192', 'mul'), [
      [1n << 191n, (1n << 65n) + 1n],
    ]);
    expect(o?.kind).toBe('revert');
    expect(o?.data).toBe(panicData(0x11n));
  });

  test('int256 −2^255 / −1 panics 0x11 on both sides (pinned)', async () => {
    const [o] = await expectAgreement(binScript('int256', 'div'), [[-(1n << 255n), -1n]]);
    expect(o?.kind).toBe('revert');
    expect(o?.data).toBe(panicData(0x11n));
  });

  test('int8 −128 / −1 panics 0x11; division by zero panics 0x12 (pinned)', async () => {
    const [a, b] = await expectAgreement(binScript('int8', 'div'), [
      [-128n, -1n],
      [5n, 0n],
    ]);
    expect(a?.data).toBe(panicData(0x11n));
    expect(b?.data).toBe(panicData(0x12n));
  });
});

// ---------------------------------------------------------------------------
// 2. comparisons, bool logic, bitwise, shifts, conversions
// ---------------------------------------------------------------------------

describe('word ops', () => {
  test('comparisons + bool logic + bitwise + shifts', async () => {
    const script = evscript(
      {
        name: 'words',
        args: [t.uint64, t.uint64, t.int32, t.int32, t.bool, t.bool, t.bytes4, t.bytes4],
      },
      (s, a, b, x, y, p, q, c, d) => {
        return s.return({
          lt: s.lt(a, b),
          gt: s.gt(a, b),
          lte: s.lte(a, b),
          gte: s.gte(a, b),
          eq: s.eq(a, b),
          neq: s.neq(a, b),
          slt: x.lt(y), // SLT from the static type
          sgt: x.gt(y),
          beq: s.eq(c, d),
          and: s.and(p, q),
          or: s.or(p, q),
          not: s.not(p),
          band: s.bitAnd(a, b),
          bor: s.bitOr(a, b),
          bxor: s.bitXor(a, b),
          bnot: s.bitNot(a), // re-masked to 64 bits
          shl: s.shl(a, 5n),
          shr: s.shr(a, 5n),
          cnot: c.bitNot(),
          cshl: c.shl(8n),
        });
      },
    );
    const max64 = (1n << 64n) - 1n;
    await expectAgreement(script, [
      [1n, 2n, -3n, 3n, true, false, '0xdeadbeef', '0xdeadbeef'],
      [max64, max64, -1n, -1n, true, true, '0x00000001', '0xffffffff'],
      [7n, 7n, -(1n << 31n), (1n << 31n) - 1n, false, false, '0xffffffff', '0x00000000'],
    ]);
  });

  test('conversions: free widening, checked narrowing, reinterprets', async () => {
    const script = evscript({ name: 'conv', args: [t.uint256, t.int16] }, (s, a, x) => {
      return s.return({
        widened: x.toInt('int128'),
        narrowed: a.toUint('uint32'), // Panic 0x11 when a ≥ 2^32
        addr: a.asAddress(), // Panic when high 96 bits set
        asb: a.asBytes32(),
        back: a.asBytes32().asUint256(),
      });
    });
    const outcomes = await expectAgreement(script, [
      [1234n, -42n],
      [0n, -(1n << 15n)],
      [1n << 40n, 7n], // narrowing panic
      [1n << 200n, 7n], // narrowing panic (recorded first), asAddress also impossible
    ]);
    expect(outcomes[2]?.kind).toBe('revert');
    expect(outcomes[2]?.data).toBe(panicData(0x11n));
  });

  test('select is eager on both sides (words and memrefs)', async () => {
    const script = evscript({ name: 'sel', args: [t.bool, t.uint256, t.uint256] }, (s, c, a, b) => {
      const w = s.select(c, a, b);
      const str = s.select(c, s.lit(t.string, 'yes'), s.lit(t.string, 'no'));
      return s.return({ w, str });
    });
    await expectAgreement(script, [
      [true, 1n, 2n],
      [false, 1n, 2n],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. env ops
// ---------------------------------------------------------------------------

describe('env ops', () => {
  test('address/caller/timestamp/blocknumber/chainid agree with the harness env', async () => {
    const script = evscript({ name: 'env', args: [] }, (s) =>
      s.return({
        self: s.env('address'),
        caller: s.env('caller'),
        ts: s.env('timestamp'),
        bn: s.env('blocknumber'),
        chain: s.env('chainid'),
      }),
    );
    await expectAgreement(script, [[]]);
  });

  // The default `toViem()` mode is deployless: viem CREATE2-deploys the initBytecode and
  // CALLs the fresh contract from its wrapper, so env('caller')/env('address') observe
  // DIFFERENT, uncontrollable values than in the state-override frame the interp defaults
  // (and `expectAgreement` above) pin. This case closes that oracle blind spot: the
  // deployless-shaped harness exposes the divergence and `interpret`'s env overrides
  // reproduce it byte-exactly.
  test('deployless frame: caller/address diverge from the state-override constants; interp env overrides model it', async () => {
    const script = evscript({ name: 'whoami', args: [] }, (s) =>
      s.return({ who: s.env('caller'), me: s.env('address') }),
    );
    const compiled = compile(script);
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: 'whoami' });

    const res = await execRuntimeDeployless(compiled.initBytecode, calldata);
    expect(res.success).toBe(true);
    const decoded = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'whoami',
      data: res.data,
    });
    // the deployless frame: caller = the wrapper contract, address = the created address —
    // and NEITHER equals the state-override-frame constants every other env test pins
    expect(decoded.who.toLowerCase()).toBe(DEPLOYLESS_WRAPPER_ADDRESS.toLowerCase());
    expect(decoded.me.toLowerCase()).toBe(res.scriptAddress.toLowerCase());
    expect(decoded.who.toLowerCase()).not.toBe(CALLER_ADDRESS.toLowerCase());
    expect(decoded.me.toLowerCase()).not.toBe(SCRIPT_ADDRESS.toLowerCase());

    // interpret with matching env overrides byte-agrees with the deployless execution …
    const overridden = interpret(script.ir, [], chainOf({}), {
      env: { caller: res.callerAddress, address: res.scriptAddress },
    }).outcome;
    expect(overridden.kind).toBe('return');
    expect(overridden.data).toBe(res.data);

    // … while the default interp env (state-override frame) does NOT match this frame
    const dflt = interpret(script.ir, [], chainOf({})).outcome;
    expect(dflt.kind).toBe('return');
    expect(dflt.data).not.toBe(res.data);
  });
});

// ---------------------------------------------------------------------------
// 4. control flow
// ---------------------------------------------------------------------------

describe('control flow', () => {
  test('if/else with cells (checked mul/div inside branches)', async () => {
    const script = evscript({ name: 'health', args: [t.uint256, t.uint256] }, (s, debt, coll) => {
      const ratio = s.let(t.uint256, 0n);
      s.if(
        debt.gt(0n),
        () => ratio.set(coll.mul(10_000n).div(debt)),
        () => ratio.set(s.lit(t.uint256, 2n ** 255n)),
      );
      return s.return({ ratio: ratio.get(), healthy: ratio.get().gte(15_000n) });
    });
    await expectAgreement(script, [
      [0n, 5n],
      [100n, 200n],
      [3n, 1n],
      [1n, 1n << 250n], // mul overflow inside the then-branch → Panic 0x11
    ]);
  });

  test('while with break + continue + cells', async () => {
    const script = evscript({ name: 'loopy', args: [t.uint256] }, (s, n) => {
      const acc = s.let(t.uint256, 0n);
      const i = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(n),
        (loop) => {
          const cur = i.get();
          i.set(cur.add(1n));
          s.if(cur.eq(3n), () => loop.continue());
          s.if(acc.get().gt(50n), () => loop.break());
          acc.set(acc.get().add(cur));
        },
      );
      return s.return({ acc: acc.get(), i: i.get() });
    });
    await expectAgreement(script, [[0n], [1n], [5n], [10n], [30n]]);
  });

  test('for over a runtime array arg, collecting into a MutArray', async () => {
    const script = evscript({ name: 'doubleAll', args: [t.array(t.uint64)] }, (s, xs) => {
      const n = xs.length();
      const out = s.newArray(t.uint256, n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
        out.set(i, xs.at(i).toUint('uint256').mul(2n));
      });
      return s.return({ out: out.expr(), n });
    });
    const max64 = (1n << 64n) - 1n;
    await expectAgreement(script, [[[]], [[1n, 2n, 3n]], [[max64, 0n, 5n]]]);
  });
});

// ---------------------------------------------------------------------------
// 5. dynamic args / returns + literals (all three evm versions)
// ---------------------------------------------------------------------------

const echoScript = () =>
  evscript(
    { name: 'echoArgs', args: [t.string, t.bytes, t.array(t.int32), t.uint256] },
    (sb, s, b, xs, i) =>
      sb.return({
        s,
        b,
        xs,
        slen: s.length(),
        blen: b.length(),
        n: xs.length(),
        at: xs.at(i), // Panic 0x32 when out of bounds
      }),
  );

describe('dynamic values', () => {
  const LONG = 'a long string deliberately exceeding thirty-two bytes — memcpy territory ✓';

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`echo string/bytes/int32[] round-trip [${evmVersion}]`, async () => {
      await expectAgreement(
        echoScript(),
        [
          ['hello', '0xdeadbeef', [-3n, 7n, 2147483647n], 1n],
          [LONG, `0x${'ab'.repeat(77)}`, [-2147483648n], 0n],
        ],
        {},
        evmVersion,
      );
    });
  }

  test('out-of-bounds index on a dynamic arg panics 0x32 on both sides', async () => {
    const outcomes = await expectAgreement(echoScript(), [
      ['x', '0x', [1n], 99n],
      ['', '0x', [], 0n],
    ]);
    expect(outcomes[0]?.data).toBe(panicData(0x32n));
    expect(outcomes[1]?.data).toBe(panicData(0x32n));
  });

  test('dynamic + word literals (data segments, CODECOPY materialization)', async () => {
    const script = evscript({ name: 'lits', args: [] }, (s) => {
      const fees = s.lit(t.array(t.uint24), [100n, 500n, 3000n, 10000n]);
      return s.return({
        fees,
        fee1: fees.at(1n),
        n: fees.length(),
        msg: s.lit(t.string, 'hello evs — ütf8 ✓'),
        raw: s.lit(t.bytes, '0x00ff'),
        w: s.lit(t.bytes32, `0x${'11'.repeat(32)}`),
        addr: s.lit(t.address, TOKA),
        flag: s.lit(t.bool, true),
        neg: s.lit(t.int64, -42n),
      });
    });
    await expectAgreement(script, [[]]);
  });
});

// ---------------------------------------------------------------------------
// 6. calls with mocks
// ---------------------------------------------------------------------------

describe('calls', () => {
  test('word outputs are normalized, never reverted (dirty high bits)', async () => {
    const script = evscript({ name: 'norm', args: [] }, (s) => {
      const d = s.call({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
      const f = s.call({ address: TOKB, abi: erc20ishAbi, functionName: 'flag' });
      const tk = s.call({ address: POOL, abi: erc20ishAbi, functionName: 'tick' });
      return s.return({ d, f, tk });
    });
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(-1n) }, // uint8 ← 0xff…ff → 255
      [TOKB]: { kind: 'return', data: word((1n << 128n) | 2n) }, // bool ← nonzero → true
      [POOL]: { kind: 'return', data: word((0xabcn << 64n) | 0xfffff6n) }, // int24 ← …fffff6 → −10
    };
    const [o] = await expectAgreement(script, [[]], table);
    const decoded = decodeFunctionResult({
      abi: script.abi,
      functionName: 'norm',
      data: o?.data ?? '0x',
    });
    expect(decoded).toEqual({ d: 255, f: true, tk: -10 });
  });

  test('multi-output static call destructures into a tuple', async () => {
    const script = evscript({ name: 'multi', args: [] }, (s) => {
      const [a, b, c] = s.call({ address: TOKA, abi: erc20ishAbi, functionName: 'multi' });
      return s.return({ a, b, c });
    });
    const payload = concatHex(word(1n << 159n), word((1n << 200n) | 0xfffff6n), word(7n));
    await expectAgreement(script, [[]], { [TOKA]: { kind: 'return', data: payload } });
  });

  test('dynamic outputs decode in place (string, uint256[]), with a gas cap', async () => {
    const script = evscript({ name: 'dyn', args: [] }, (s) => {
      const symbol = s.call({
        address: TOKA,
        abi: erc20ishAbi,
        functionName: 'symbol',
        gas: 200_000n,
      });
      const list = s.call({ address: TOKB, abi: erc20ishAbi, functionName: 'list' });
      return s.return({ symbol, list, len: list.length(), first: list.at(0n) });
    });
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: encodeAbiParameters([{ type: 'string' }], ['PEPE']) },
      [TOKB]: {
        kind: 'return',
        data: encodeAbiParameters([{ type: 'uint256[]' }], [[7n, 8n, 9n]]),
      },
    };
    await expectAgreement(script, [[]], table);
  });

  test('sub-call calldata is byte-exact: echoed back, ABI-wrapped, and returned', async () => {
    // the callee returns abi.encode(bytes(calldata)) — ANY divergence between the
    // interpreter's and the compiler's sub-call calldata (selector, heads, dynamic tail,
    // padding) shows up as a byte mismatch of the final returndata.
    const script = evscript({ name: 'mixer', args: [t.uint256, t.bytes] }, (s, v, payload) => {
      const out = s.call({
        address: ECHO,
        abi: erc20ishAbi,
        functionName: 'mix',
        args: [v, TOKA, payload], // Expr + literal + dynamic Expr
      });
      return s.return({ out, len: out.length() });
    });
    const table: CalleeTable = {
      [ECHO]: {
        kind: 'bytecode',
        runtime: abiEchoMock(),
        respond: (calldata) => ({
          success: true,
          data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
        }),
      },
    };
    await expectAgreement(
      script,
      [
        [42n, '0x'],
        [0n, `0x${'cd'.repeat(33)}`],
      ],
      table,
    );
  });

  test('plain word call with an arg through the raw echo mock', async () => {
    const script = evscript({ name: 'echoCall', args: [t.address] }, (s, who) => {
      const r = s.call({
        address: ECHO,
        abi: erc20ishAbi,
        functionName: 'balanceOf',
        args: [who],
      });
      return s.return({ r });
    });
    const [o] = await expectAgreement(script, [[USER]], { [ECHO]: { kind: 'echo' } });
    expect(o?.kind).toBe('return');
  });

  test('strict call to an unmocked (code-less) address → EvsDecodeError, not a halt', async () => {
    const script = evscript({ name: 'ghost', args: [] }, (s) => {
      const d = s.call({ address: DEAD, abi: erc20ishAbi, functionName: 'decimals' });
      return s.return({ d });
    });
    const [o] = await expectAgreement(script, [[]]);
    expect(o?.kind).toBe('revert');
    expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. decode bounds (attacker-shaped returndata) — strict mode
// ---------------------------------------------------------------------------

describe('decode bounds', () => {
  const ATTACKER_PAYLOADS: Readonly<Record<string, Hex>> = {
    empty: '0x',
    hugeHeadOffset: word(1n << 255n),
    hugeLength: concatHex(word(32n), word(1n << 200n)),
    offByOneTruncation: concatHex(word(32n), word(32n), `0x${'ab'.repeat(31)}`),
    dirtyHighBits: word(-1n), // a 2^256−1 head offset for a dynamic output
    shortWord: `0x${'00'.repeat(30)}2a`, // 31 bytes < the 32-byte head floor
  };

  for (const [name, payload] of Object.entries(ATTACKER_PAYLOADS)) {
    test(`strict symbol() against '${name}' returndata → EvsDecodeError(site) on both sides`, async () => {
      const script = evscript({ name: 'attacked', args: [] }, (s) => {
        const symbol = s.call({ address: TOKA, abi: erc20ishAbi, functionName: 'symbol' });
        return s.return({ symbol });
      });
      const [o] = await expectAgreement(script, [[]], {
        [TOKA]: { kind: 'return', data: payload },
      });
      expect(o?.kind).toBe('revert');
      expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. revert bubbling — the REAL solc Reverter artifact vs ABI-encoded expectations
// ---------------------------------------------------------------------------

describe('revert bubbling (Reverter.sol, byte-exact)', () => {
  const RESPONSES: Readonly<Record<string, { success: boolean; data: Hex }>> = {
    [sel('revertErrorString()')]: {
      success: false,
      data: encodeErrorResult({
        abi: ERROR_ABI,
        errorName: 'Error',
        args: ['Reverter: error string'],
      }),
    },
    [sel('revertRequire()')]: {
      success: false,
      data: encodeErrorResult({
        abi: ERROR_ABI,
        errorName: 'Error',
        args: ['Reverter: require failed'],
      }),
    },
    [sel('panicAssert()')]: { success: false, data: panicData(0x01n) },
    [sel('panicOverflow()')]: { success: false, data: panicData(0x11n) },
    [sel('panicDivZero()')]: { success: false, data: panicData(0x12n) },
    [sel('panicArrayOob()')]: { success: false, data: panicData(0x32n) },
    [sel('revertCustomError()')]: {
      success: false,
      data: encodeErrorResult({
        abi: Reverter.abi,
        errorName: 'DetailedError',
        args: [42n, '0x000000000000000000000000000000000000beef'],
      }),
    },
    [sel('revertCustomErrorNoArgs()')]: {
      success: false,
      data: encodeErrorResult({ abi: Reverter.abi, errorName: 'PlainError', args: [] }),
    },
    [sel('revertEmpty()')]: { success: false, data: '0x' },
  };
  const table: CalleeTable = {
    [REVERTER]: {
      kind: 'bytecode',
      runtime: Reverter.deployedBytecode,
      respond: (calldata) =>
        RESPONSES[calldata.slice(0, 10).toLowerCase()] ?? { success: false, data: '0x' },
    },
  };
  const FNS = [
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

  for (const fn of FNS) {
    test(`${fn} bubbles verbatim through a strict call`, async () => {
      const script = evscript({ name: 'bubble', args: [] }, (s) => {
        const x = s.call({ address: REVERTER, abi: Reverter.abi, functionName: fn });
        return s.return({ x });
      });
      const [o] = await expectAgreement(script, [[]], table);
      expect(o?.kind).toBe('revert');
      expect(o?.data).toBe(RESPONSES[sel(`${fn}()`)]?.data);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. tryCall zeroing
// ---------------------------------------------------------------------------

describe('tryCall', () => {
  const tryScript = () =>
    evscript({ name: 'trying', args: [] }, (s) => {
      const d = s.tryCall({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
      const sym = s.tryCall({ address: TOKB, abi: erc20ishAbi, functionName: 'symbol' });
      const list = s.tryCall({ address: DEAD, abi: erc20ishAbi, functionName: 'list' });
      return s.return({
        ok1: d.success,
        v1: d.value,
        ok2: sym.success,
        v2: sym.value,
        ok3: list.success,
        v3: list.value,
        picked: s.select(d.success, d.value, 18),
      });
    });

  test('failure / malformed / unmocked → success=false, zeroed values', async () => {
    const table: CalleeTable = {
      [TOKA]: { kind: 'revert', data: panicData(0x01n) }, // call failure
      [TOKB]: { kind: 'return', data: concatHex(word(32n), word(1n << 200n)) }, // malformed
      // DEAD unmocked: empty returndata < head floor → malformed → zeroed
    };
    const [o] = await expectAgreement(tryScript(), [[]], table);
    const decoded = decodeFunctionResult({
      abi: tryScript().abi,
      functionName: 'trying',
      data: o?.data ?? '0x',
    });
    expect(decoded).toEqual({
      ok1: false,
      v1: 0,
      ok2: false,
      v2: '',
      ok3: false,
      v3: [],
      picked: 18,
    });
  });

  test('success path: values flow through', async () => {
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(9n) },
      [TOKB]: { kind: 'return', data: encodeAbiParameters([{ type: 'string' }], ['OK']) },
      [DEAD]: { kind: 'return', data: encodeAbiParameters([{ type: 'uint256[]' }], [[5n]]) },
    };
    await expectAgreement(tryScript(), [[]], table);
  });
});

// ---------------------------------------------------------------------------
// 10. user functions (fncall — no aliasing, calls inside bodies)
// ---------------------------------------------------------------------------

describe('user functions', () => {
  test('fn called twice + multi-result fn (no aliasing); panics propagate through fns', async () => {
    const script = evscript({ name: 'fns', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const double = s.fn('double', [arg('x', t.uint256)] as const, (x) => x.add(x));
      const da = double(a);
      const db = double(b);
      const pair = s.fn(
        'pair',
        [arg('x', t.uint256), arg('y', t.uint256)] as const,
        (x, y) => [x.add(y), x.mul(y)] as const,
      );
      const [sum, prod] = pair(da, db);
      return s.return({ da, db, sum, prod });
    });
    await expectAgreement(script, [
      [2n, 3n],
      [0n, 0n],
      [1n << 255n, 1n], // overflow inside `double` → Panic 0x11
    ]);
  });

  test('fn body records sub-calls (E5 portfolio shape)', async () => {
    const script = evscript(
      { name: 'portfolio', args: [t.address, t.array(t.address)] },
      (s, owner, tokens) => {
        const balOf = s.fn(
          'balOf',
          [arg('token', t.address), arg('who', t.address)] as const,
          (token, who) =>
            s.call({ address: token, abi: erc20ishAbi, functionName: 'balanceOf', args: [who] }),
        );
        const n = tokens.length();
        const out = s.newArray(t.uint256, n);
        s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
          out.set(i, balOf(tokens.at(i), owner));
        });
        return s.return({ balances: out.expr() });
      },
    );
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(111n) },
      [TOKB]: { kind: 'return', data: word(222n) },
    };
    await expectAgreement(
      script,
      [
        [USER, [TOKA, TOKB]],
        [USER, []],
      ],
      table,
    );
  });
});

// ---------------------------------------------------------------------------
// 11. flagship corpus — E1 poolMeta and E2 balances, all three evm versions
// ---------------------------------------------------------------------------

describe('flagship', () => {
  const poolTable: CalleeTable = {
    [POOL]: {
      kind: 'dispatch',
      cases: [
        { selector: sel('token0()'), kind: 'return', data: word(BigInt(TOKA)) },
        { selector: sel('token1()'), kind: 'return', data: word(BigInt(TOKB)) },
        {
          selector: sel('slot0()'),
          kind: 'return',
          data: concatHex(word(1n << 96n), word(-887272n)),
        },
      ],
    },
    [TOKA]: {
      kind: 'dispatch',
      cases: [
        {
          selector: sel('symbol()'),
          kind: 'return',
          data: encodeAbiParameters([{ type: 'string' }], ['WETH']),
        },
        {
          selector: sel('decimals()'),
          kind: 'revert',
          data: encodeErrorResult({ abi: ERROR_ABI, errorName: 'Error', args: ['nope'] }),
        },
        { selector: sel('balanceOf(address)'), kind: 'return', data: word(123_456n) },
      ],
    },
    [TOKB]: {
      kind: 'dispatch',
      cases: [
        {
          selector: sel('symbol()'),
          kind: 'return',
          data: encodeAbiParameters([{ type: 'string' }], ['USDC']),
        },
      ],
    },
  };

  const poolMeta = () =>
    evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, user) => {
      const token0 = s.call({ address: pool, abi: erc20ishAbi, functionName: 'token0' });
      const token1 = s.call({ address: pool, abi: erc20ishAbi, functionName: 'token1' });
      const slot0 = s.call({ address: pool, abi: erc20ishAbi, functionName: 'slot0' });
      const symbol0 = s.call({ address: token0, abi: erc20ishAbi, functionName: 'symbol' });
      const symbol1 = s.call({ address: token1, abi: erc20ishAbi, functionName: 'symbol' });
      const dec = s.tryCall({ address: token0, abi: erc20ishAbi, functionName: 'decimals' });
      const decimals0 = s.select(dec.success, dec.value, 18);
      const bal0 = s.call({
        address: token0,
        abi: erc20ishAbi,
        functionName: 'balanceOf',
        args: [user],
      });
      return s.return({ token0, token1, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
    });

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`E1 poolMeta — data flows between calls [${evmVersion}]`, async () => {
      const script = poolMeta();
      const [o] = await expectAgreement(script, [[POOL, USER]], poolTable, evmVersion);
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'poolMeta',
        data: o?.data ?? '0x',
      });
      expect(decoded).toMatchObject({
        symbol0: 'WETH',
        symbol1: 'USDC',
        tick: -887272,
        decimals0: 18, // tryCall failed → default
        bal0: 123_456n,
      });
    });
  }

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`E2 balances — loop + tryCall + MutArray output [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'balances', args: [t.array(t.address), t.address] },
        (s, tokens, owner) => {
          const n = tokens.length();
          const out = s.newArray(t.uint256, n);
          s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
            const token = tokens.at(i);
            const r = s.tryCall({
              address: token,
              abi: erc20ishAbi,
              functionName: 'balanceOf',
              args: [owner],
            });
            out.set(i, s.select(r.success, r.value, 0n));
          });
          return s.return({ balances: out.expr() });
        },
      );
      const table: CalleeTable = {
        [TOKA]: { kind: 'return', data: word(11n) },
        [TOKB]: { kind: 'return', data: word(22n) },
        // DEAD stays unmocked → tryCall yields success=false → 0
      };
      const [o] = await expectAgreement(script, [[[TOKA, DEAD, TOKB], USER]], table, evmVersion);
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'balances',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ balances: [11n, 0n, 22n] });
    });
  }
});

// ---------------------------------------------------------------------------
// 12. composite types — tuple decode (struct output) + tuple construct/encode (issue #2)
// ---------------------------------------------------------------------------

describe('composite types', () => {
  // a five-field static struct, the Composite.Position shape (mirrors UniV3 positions()).
  const positionComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
    { name: 'feeGrowthInside0', type: 'uint256' },
    { name: 'feeGrowthInside1', type: 'uint256' },
  ] as const;
  const positionAbi = [
    {
      type: 'function',
      name: 'positions',
      stateMutability: 'view',
      inputs: [{ name: 'tokenId', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple', components: positionComponents }],
    },
  ] as const satisfies Abi;
  const Position = t.struct({
    nonce: t.uint96,
    operator: t.address,
    liquidity: t.uint128,
    feeGrowthInside0: t.uint256,
    feeGrowthInside1: t.uint256,
  });
  const OPERATOR = getAddress('0x00000000000000000000000000000000000000aa');
  const POSITION = {
    nonce: 7n,
    operator: OPERATOR,
    liquidity: 123_456n,
    feeGrowthInside0: 1n << 200n,
    feeGrowthInside1: (1n << 255n) | 9n,
  } as const;
  // the mock callee returns viem's canonical tuple encoding — the differential oracle.
  const positionReturndata = encodeAbiParameters(
    [{ type: 'tuple', components: positionComponents }],
    [POSITION],
  );

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`decode a struct output and return a field [${evmVersion}]`, async () => {
      // (a) decode the Position output, read a static field after the head/tail decode.
      const script = evscript({ name: 'getLiq', args: [t.uint256] }, (s, tokenId) => {
        const pos = s.call({
          address: POOL,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ liquidity: pos.liquidity.get(), operator: pos.operator.get() });
      });
      const [o] = await expectAgreement(
        script,
        [[1n]],
        { [POOL]: { kind: 'return', data: positionReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'getLiq',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ liquidity: POSITION.liquidity, operator: POSITION.operator });
    });

    test(`decode a struct output and return the whole tuple [${evmVersion}]`, async () => {
      // (a′) re-encode the decoded tuple as a tuple OUTPUT — flat-block → ABI head/tail must
      // round-trip byte-exactly against viem's tuple codec.
      const script = evscript({ name: 'echoPos', args: [t.uint256] }, (s, tokenId) => {
        const pos = s.call({
          address: POOL,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ pos: pos.expr() });
      });
      const [o] = await expectAgreement(
        script,
        [[1n]],
        { [POOL]: { kind: 'return', data: positionReturndata } },
        evmVersion,
      );
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'echoPos',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ pos: POSITION });
    });

    test(`construct a tuple and return it [${evmVersion}]`, async () => {
      // (b) build a Position from scratch (alloc + zero-fill + MSTORE provided members), mutate
      // one field, then return the tuple — encode bytes must equal viem's.
      const script = evscript({ name: 'mkPos', args: [t.address, t.uint128] }, (s, owner, liq) => {
        const pos = s.tuple(Position, {
          nonce: 7n,
          operator: owner,
          liquidity: liq,
          feeGrowthInside0: 1n << 200n,
          // feeGrowthInside1 omitted → zero-filled
        });
        pos.feeGrowthInside1.set((1n << 255n) | 9n);
        return s.return({ pos: pos.expr() });
      });
      const [o] = await expectAgreement(
        script,
        [[POSITION.operator, POSITION.liquidity]],
        {},
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkPos',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ pos: POSITION });
    });
  }
});

// ---------------------------------------------------------------------------
// helper mocks
// ---------------------------------------------------------------------------

/** Runtime that returns `abi.encode(bytes(calldata))` — the sub-call-calldata oracle. */
function abiEchoMock(): Hex {
  const w = new AsmWriter();
  w.push(0x20);
  w.push(0);
  w.op('MSTORE'); // mem[0] = 0x20 (head offset)
  w.op('CALLDATASIZE');
  w.push(0x20);
  w.op('MSTORE'); // mem[0x20] = len
  w.op('CALLDATASIZE');
  w.push(0);
  w.push(0x40);
  w.op('CALLDATACOPY'); // mem[0x40..] = calldata (fresh memory beyond is zero — padding)
  w.op('CALLDATASIZE');
  w.push(31);
  w.op('ADD');
  w.push(31);
  w.op('NOT');
  w.op('AND'); // ceil32(len)
  w.push(0x40);
  w.op('ADD');
  w.push(0);
  w.op('RETURN'); // return(0, 0x40 + ceil32(len))
  const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
  let hex = '';
  for (const b of bytecode) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}
