/**
 * Golden-bytecode regression tests: snapshot the compiled runtime bytecode of representative
 * scripts spanning the emitter paths — template + recursive calldata encode, word / string /
 * tuple / composite-array outputs, all six calling verbs (strict + try), gas caps, call value, literal
 * and runtime args, and array construction.
 *
 * A snapshot change here means the emitted BYTES changed. That must always be a deliberate
 * codegen change (update the snapshot in the same PR and say why) — never a side effect of a
 * refactor. Execution semantics are covered by the interp/differential/integration tiers;
 * this tier pins byte-for-byte stability.
 *
 * Every case is snapshotted twice: the default output (the `optimize: false` bytes MUST stay
 * identical whatever the optimizer does) and its `optimize: true` twin (the peephole pass,
 * issue #39, over the liveness-packed frame, issue #41), which is additionally asserted to
 * never be larger.
 */
import type { Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { plannerAgainstReference } from '../test/harness/codec-plan.js';
import { assemble } from './asm/assembler.js';
import type { EvmVersion } from './asm/ops.js';
import { evscript } from './builder/script.js';
import { evsPeephole } from './codegen/peephole.js';
import { lowerProgram } from './codegen/program.js';
import { compile, type CompiledEvsScript } from './compile.js';
import { namedArg, t, type Hex } from './core/types.js';
import { eliminateDeadCode } from './ir/dce.js';
import type { ScriptIr } from './ir/nodes.js';

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
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
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const payableAbi = [
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'payable',
    inputs: [{ name: 'referral', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const poolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const satisfies Abi;

const TOKEN = '0xa000000000000000000000000000000000000001' as const;

interface Case {
  readonly name: string;
  readonly script: () => {
    readonly name: string;
    readonly ir: ScriptIr;
    readonly abi: readonly unknown[];
  };
  readonly evmVersion?: EvmVersion;
}

const BYTE_STABLE: readonly Case[] = [
  {
    name: 'arithmetic + select + literals (no calls)',
    script: () =>
      evscript({ name: 'math', args: [t.uint256, t.uint256] }, (s, a, b) => {
        const sum = s.add(a, b);
        const bigger = s.select(s.gt(a, b), a, b);
        const capped = s.select(s.gt(sum, s.lit(t.uint256, 1000n)), s.lit(t.uint256, 1000n), sum);
        return s.return({ sum, bigger, capped });
      }),
  },
  {
    name: 'reads: string output, arg + gas cap, tuple-index output, tryRead + select',
    script: () =>
      evscript({ name: 'reads', args: [t.address, t.address] }, (s, pool, user) => {
        const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
        const bal = s.read({
          address: pool,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [user],
          gas: 100_000n,
        });
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
        const dec = s.tryRead({ address: TOKEN, abi: erc20Abi, functionName: 'decimals' });
        const decimals = s.select(dec.success, dec.value, s.lit(t.uint8, 18));
        return s.return({ symbol, bal, tick: slot0[1], decimals });
      }),
  },
  {
    name: 'struct: true read + tryRead (tuple output through the memory decoders)',
    script: () =>
      evscript({ name: 'structs', args: [t.address] }, (s, pool) => {
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        const r = s.tryRead({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        return s.return({
          price: slot0.sqrtPriceX96.get(),
          ok: r.success,
          tick: r.value.tick.get(),
        });
      }),
  },
  {
    name: 'mutable verbs: call / tryCall / simulate / trySimulate',
    script: () =>
      evscript({ name: 'writes', args: [t.address, t.address] }, (s, token, to) => {
        const sent = s.call({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 1000n],
        });
        const trySent = s.tryCall({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 1000n],
        });
        const simSent = s.simulate({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 2000n],
        });
        const trySim = s.trySimulate({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 3000n],
        });
        return s.return({
          sent,
          okA: trySent.success,
          sentB: trySent.value,
          simSent,
          okC: trySim.success,
          sentD: trySim.value,
        });
      }),
  },
  {
    name: 'call value: s.call / s.trySimulate sending runtime and literal value',
    script: () =>
      evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, target, amount) => {
        const p = {
          address: target,
          abi: payableAbi,
          functionName: 'submit',
          args: [target],
        } as const;
        const sent = s.call({ ...p, value: amount });
        const sim = s.trySimulate({ ...p, value: 1n });
        return s.return({ sent, ok: sim.success, sim: sim.value });
      }),
  },
  {
    name: 'array construction + loop-free mutation',
    script: () =>
      evscript({ name: 'arr', args: [t.uint256] }, (s, n) => {
        const out = s.newArray(t.uint256, n);
        out.set(0n, 42n);
        return s.return({ all: out });
      }),
  },
  {
    name: 'paris target (pre-PUSH0 / @memcpy fork)',
    evmVersion: 'paris',
    script: () =>
      evscript({ name: 'paris', args: [t.address] }, (s, pool) => {
        const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
        return s.return({ symbol });
      }),
  },
  {
    name: 'checked pow (loop / folded base / folded exponent) + addmod / mulmod (issue #10)',
    script: () =>
      evscript({ name: 'powmod', args: [t.int64, t.uint8, t.uint256] }, (s, x, e, n) => {
        const p = x.pow(e); // runtime base + exponent: the signed checked loop
        const two = s.lit(t.uint256, 2n).pow(e); // folded base: e ≤ 255 + EXP
        const cube = n.pow(3n); // folded exponent: root bound + EXP
        const am = n.addmod(two, n); // zero-modulus guard
        const mm = s.mulmod(cube, am, 1_000_000_007n); // literal modulus: guard elided
        return s.return({ p, mm });
      }),
  },
  {
    name: 'checked pow with huge folded exponents (2^128 unsigned, 2^256 − 1 signed): |a| ≤ 1 bound',
    script: () =>
      evscript({ name: 'powhuge', args: [t.uint256, t.int64] }, (s, u, i) =>
        s.return({ u: u.pow(1n << 128n), i: i.pow((1n << 256n) - 1n) }),
      ),
  },
  {
    name: 'wrapping add / sub / mul (bare opcode, mask, SIGNEXTEND) + mulDiv / mulDivRoundingUp',
    script: () =>
      evscript({ name: 'wrapmuldiv', args: [t.uint256, t.uint8, t.int64] }, (s, x, u, i) => {
        const w = x.wrappingMul(x).wrappingSub(1n); // uint256: the bare opcodes
        const m = u.wrappingAdd(200n); // uint8: masked
        const n = s.wrappingMul(i, -3n); // int64: SIGNEXTEND
        const q = w.mulDiv(x, 1n << 96n); // literal denominator: zero guard elided
        const c = s.mulDivRoundingUp(q, x, w); // runtime denominator + the rounding increment
        return s.return({ m, n, c });
      }),
  },
];

const Position = t.struct({ nonce: t.uint96, operator: t.address, liquidity: t.uint128 });

const gridAbi = [
  {
    type: 'function',
    name: 'grid',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple[][]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
] as const satisfies Abi;

// three levels of nested dynamic structs: the innermost reads its base from a tuple frame
const nestedAbi = [
  {
    type: 'function',
    name: 'deep',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'a', type: 'uint256' },
          { name: 's', type: 'string' },
          {
            name: 'inner',
            type: 'tuple',
            components: [
              { name: 'a', type: 'uint256' },
              { name: 's', type: 'string' },
              {
                name: 'inner',
                type: 'tuple',
                components: [
                  { name: 'a', type: 'uint256' },
                  { name: 's', type: 'string' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
] as const satisfies Abi;

// Array decode paths (#4, #52). The first two cases are the #52 regression corpus: one- and
// two-level composite arrays decode on the STACK fast path, and their size and gas must never
// exceed what they were before the heap-frame decoder existed (the body bounds check moved ahead
// of the allocation in the 0.2.0 codec review — same instructions, reordered — and the u64
// bounds shrank to `PUSH1 64 SHR` in the field-test efficiency review). The next ones pin the
// shapes that take the heap-frame path (`string[2]`, `tuple[][]`, `uint256[][][]`) and the typed
// zeros of fixed-size arrays; the last ones the fixed-word bulk copy (`MCOPY` on cancun, a copy
// loop before) and the tuple frames of nested dynamic structs.
const ARRAY_DECODE: readonly Case[] = [
  {
    name: '#52 corpus: uint256[][] + string[] args, nested forEach, returned back (stack fast path)',
    script: () =>
      evscript(
        { name: 'nested', args: [t.array(t.array(t.uint256)), t.array(t.string)] },
        (s, grid, names) => {
          const total = s.let(t.uint256, 0n);
          s.forEach(grid, (row) => {
            s.forEach(row, (x) => {
              total.set(total.get().add(x));
            });
          });
          const lens = s.let(t.uint256, 0n);
          s.forEach(names, (n) => {
            lens.set(lens.get().add(n.length()));
          });
          return s.return({ grid, names, total: total.get(), lens: lens.get() });
        },
      ),
  },
  {
    name: '#52 corpus: tuple[] arg iterated + s.newArray(struct) returned (stack fast path)',
    script: () =>
      evscript({ name: 'structs', args: [t.array(Position)] }, (s, ps) => {
        const out = s.newArray(Position, ps.length());
        s.forEach(ps, (p, i) => {
          const q = out.get(i);
          q.nonce.set(p.nonce.get());
          q.operator.set(p.operator.get());
          q.liquidity.set(p.liquidity.get().add(1n));
        });
        return s.return({ out });
      }),
  },
  {
    name: '#4 heap-frame decode: uint256[2] + string[2] + uint256[][][] args returned',
    script: () =>
      evscript(
        { name: 'fixedDeep', args: ['uint256[2]', 'string[2]', 'uint256[][][]'] },
        (s, pair, names, cube) =>
          s.return({ sum: pair.at(0n).add(pair.at(1n)), names, cube, slabs: cube.length() }),
      ),
  },
  {
    name: '#4 heap-frame decode: tuple[][] call output (strict + try) iterated',
    script: () =>
      evscript({ name: 'grids', args: [t.address] }, (s, pool) => {
        const grid = s.read({ address: pool, abi: gridAbi, functionName: 'grid' });
        const tried = s.tryRead({ address: pool, abi: gridAbi, functionName: 'grid' });
        const ids = s.let(t.uint256, 0n);
        s.forEach(grid, (row) => {
          s.forEach(row, (cell) => {
            ids.set(ids.get().add(cell.id.get()));
          });
        });
        return s.return({ ids: ids.get(), ok: tried.success, rows: tried.value.length() });
      }),
  },
  {
    name: '#4 fixed-size construction: typed zeros of string[2] / uint256[2][] / tuple[2]',
    script: () =>
      evscript({ name: 'zeros', args: [t.uint256] }, (s, x) => {
        const names = s.newArray(t.string, 2, { fixed: true });
        const pairs = s.newArray(t.array(t.uint256, 2), x);
        const ps = s.newArray(t.array(Position, 2), 1n);
        return s.return({ names, pairs, ps });
      }),
  },
  ...(['cancun', 'paris'] as const).map((evmVersion): Case => ({
    name: `fixed-word bulk copy + tuple frames: uint256[4] / uint8[3] args, nested-struct output [${evmVersion}]`,
    evmVersion,
    script: () =>
      evscript(
        { name: 'bulk', args: ['uint256[4]', 'uint8[3]', t.address] },
        (s, words, bytes, target) => {
          const deep = s.read({ address: target, abi: nestedAbi, functionName: 'deep' });
          const leaf = deep.inner.get().inner.get();
          return s.return({ words, bytes, a: leaf.a.get(), s: leaf.s.get() });
        },
      ),
  })),
];

const CUSTOM_ERRORS: readonly Case[] = [
  {
    name: 'throw: named args, zero-arg, and a string param (dynamic encode)',
    script: () => {
      const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
      const NotOwner = t.error('NotOwner');
      const Reason = t.error('Reason', [namedArg('note', t.string)]);
      return evscript(
        { name: 'guard', args: [t.uint256], errors: [NoBalance, NotOwner, Reason] },
        (s, x) => {
          s.if(x.lt(10n), () => {
            s.throw(NoBalance, { balance: x });
          });
          s.if(x.eq(999n), () => {
            s.throw(NotOwner);
          });
          s.if(x.eq(1000n), () => {
            s.throw(Reason, { note: s.lit(t.string, 'nope') });
          });
          return s.return({ x });
        },
      );
    },
  },
];

function bytesOf(c: Case, optimize: boolean): Hex {
  const options =
    c.evmVersion === undefined ? { optimize } : { optimize, evmVersion: c.evmVersion };
  // CompiledOf<s> is deferred on the structural script type — annotate like the differential suite
  const compiled: CompiledEvsScript = compile(c.script(), options);
  return compiled.runtimeBytecode;
}

describe('runtime bytecode is byte-stable', () => {
  for (const c of BYTE_STABLE) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      expect(bytesOf(c, false)).toMatchSnapshot();
    });
  }
});

describe('custom errors are byte-stable (issue #15)', () => {
  for (const c of CUSTOM_ERRORS) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      expect(bytesOf(c, false)).toMatchSnapshot();
    });
  }
});

describe('array decode paths are byte-stable (issues #4, #52)', () => {
  for (const c of ARRAY_DECODE) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      expect(bytesOf(c, false)).toMatchSnapshot();
    });
  }
});

describe('optimized twin (optimize: true) is byte-stable (issue #39)', () => {
  for (const c of [...BYTE_STABLE, ...CUSTOM_ERRORS, ...ARRAY_DECODE]) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      const plain = bytesOf(c, false);
      const optimized = bytesOf(c, true);
      expect(optimized.length).toBeLessThanOrEqual(plain.length);
      expect(optimized).toMatchSnapshot();
    });
  }
});

describe('codec sharing never grows a program, and its planner shortcuts decide alike (issue #95)', () => {
  for (const c of [...BYTE_STABLE, ...CUSTOM_ERRORS, ...ARRAY_DECODE]) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table
    test(c.name, () => {
      const evmVersion = c.evmVersion ?? 'cancun';
      for (const optimize of [false, true]) {
        const script = c.script();
        // the same program with every codec inlined (codegen/codecs.ts off)
        const lowered = lowerProgram(eliminateDeadCode(script.ir), {
          evmVersion,
          optimize,
          shareCodecs: false,
        });
        const inline = assemble(lowered.nodes, {
          evmVersion,
          ...(optimize ? { peephole: evsPeephole } : {}),
        }).bytecode;
        expect((bytesOf(c, optimize).length - 2) / 2).toBeLessThanOrEqual(inline.length);
        // the planner's compile-time shortcuts take the exhaustive planner's decisions
        const { fast, reference } = plannerAgainstReference(script.ir, evmVersion, optimize);
        expect(fast).toEqual(reference);
      }
    });
  }
});
