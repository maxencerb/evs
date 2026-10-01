/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — checked arithmetic (boundary matrix), word ops, env ops, account reads.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  chainOf,
  DEAD,
  ECHO,
  EVM_VERSIONS,
  expectAgreement,
  panicData,
  TOKA,
  USER,
} from '../../test/harness/differential.js';
import {
  CALLER_ADDRESS,
  DEPLOYLESS_WRAPPER_ADDRESS,
  execRuntime,
  execRuntimeDeployless,
  SCRIPT_ADDRESS,
} from '../../test/harness/evm.js';
import { word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type NumericType } from '../core/types.js';
import { interpret } from '../ir/interp.js';

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
  // agreement only: the exact Panic payloads of the hard boundaries (uint192 wrap-back,
  // minN / −1, division by zero) are pinned per side in codegen/lower.test.ts and
  // ir/interp.test.ts, so agreeing with the interpreter pins both builds to them
  for (const type of WIDTHS) {
    for (const op of BIN_OPS) {
      test(`${op} ${type}`, async () => {
        await expectAgreement(binScript(type, op), operandPairs(type));
      });
    }
  }
});

describe('checked div / mod by literal divisors (const-divisor guard elision)', () => {
  // a folded nonzero divisor drops the Panic 0x12 zero check and, unless it is −1, signed
  // div's minN / −1 check — a literal 0 and a literal −1 keep them (issue #72)
  function constScript(type: NumericType, op: 'div' | 'mod', divisor: bigint) {
    return evscript({ name: `const_${op}`, args: [type] }, (s, a) =>
      s.return({ r: op === 'div' ? s.div(a, divisor) : s.mod(a, divisor) }),
    );
  }
  for (const type of WIDTHS) {
    const { min, max } = rangeOf(type);
    const divisors =
      min < 0n ? [0n, 1n, 3n, max, -1n, -2n, -7n, min] : [0n, 1n, 7n, 1_000_003n % (max + 1n), max];
    const dividends = min < 0n ? [[0n], [1n], [-1n], [min], [max], [-100n]] : [[0n], [1n], [max]];
    for (const op of ['div', 'mod'] as const) {
      test(`${op} ${type} by literals`, async () => {
        await Promise.all(
          divisors.map((d) => expectAgreement(constScript(type, op, d), dividends)),
        );
      });
    }
  }

  test('the issue #72 repro: mod / mul / div by literals', async () => {
    const script = evscript({ name: 'arith', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const x = a.mod(1_000_003n);
      const w = x.mul(7n).add(b).div(7n);
      return s.return({ w });
    });
    await expectAgreement(script, [
      [0n, 0n],
      [123_456_789n, 42n],
      [(1n << 256n) - 1n, 5n],
    ]);
  });
});

describe('checked add / sub / mul by literals (folded-constant templates)', () => {
  // unsigned mul by a literal compares x against ⌊max / c⌋; int256 add / sub by a literal
  // checks only the sign case the literal allows (a negative one is applied as its magnitude)
  for (const type of ['uint8', 'uint64', 'uint192', 'uint256'] as const) {
    test(`mul ${type} by literals, on either side`, async () => {
      const { max } = rangeOf(type);
      const constants = [0n, 1n, 2n, 3n, 997n, 10n ** 18n, max >> 1n, max].filter((c) => c <= max);
      await Promise.all(
        constants.flatMap((c) => {
          const xs = [0n, 1n, max, ...(c > 1n ? [max / c, max / c + 1n] : [])].map((x) => [x]);
          return [
            expectAgreement(
              evscript({ name: 'mulr', args: [type] }, (s, x) => s.return({ r: s.mul(x, c) })),
              xs,
            ),
            expectAgreement(
              evscript({ name: 'mull', args: [type] }, (s, x) => s.return({ r: s.mul(c, x) })),
              xs,
            ),
          ];
        }),
      );
    });
  }

  test('int256 add / sub by literals of either sign, on either side', async () => {
    const { min, max } = rangeOf('int256');
    const constants = [0n, 1n, -1n, 5n, -5n, max, min];
    const xs = [min, min + 4n, -1n, 0n, 1n, max - 4n, max].map((x) => [x]);
    await Promise.all(
      constants.flatMap((k) => [
        expectAgreement(
          evscript({ name: 'f', args: [t.int256] }, (s, x) =>
            s.return({ add: x.add(k), sub: x.sub(k) }),
          ),
          xs,
        ),
        expectAgreement(
          evscript({ name: 'f', args: [t.int256] }, (s, x) =>
            s.return({ add: s.add(k, x), sub: s.sub(k, x) }),
          ),
          xs,
        ),
      ]),
    );
  });

  test('method chains: the just-stored left operand loads first (operands swapped)', async () => {
    const script = evscript(
      { name: 'chain', args: [t.uint256, t.uint256, t.int64, t.int64, t.bool] },
      (s, a, b, x, y, p) => {
        const u = a.add(b).mul(b).bitXor(a).bitOr(b).bitAnd(a);
        const v = x.add(y).mul(y).sub(y);
        return s.return({
          u,
          v,
          ult: u.add(1n).lt(b),
          ugte: u.add(1n).gte(b),
          slt: v.add(1n).lt(y),
          sgt: v.add(1n).gt(y),
          slte: v.add(1n).lte(y),
          eq: a.add(0n).eq(b),
          neq: a.add(0n).neq(b),
          and: x.lt(y).and(p),
          or: x.gt(y).or(p),
        });
      },
    );
    const max = (1n << 256n) - 1n;
    const max64 = (1n << 63n) - 1n;
    await expectAgreement(script, [
      [1n, 2n, -3n, 4n, true],
      [5n, 5n, 4n, -3n, false],
      [0n, max, -1n, -1n, true],
      [max, 1n, 1n, 2n, false], // uint256 add overflow
      [1n << 128n, 1n << 128n, 1n, 2n, false], // uint256 mul overflow
      [1n, 2n, max64, 1n, false], // int64 add overflow
      [1n, 2n, -(1n << 62n), 3n, true], // int64 mul overflow
    ]);
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
// 4. account reads — s.balance / s.codeSize / s.codeHash (BALANCE, EXTCODESIZE, EXTCODEHASH)
// ---------------------------------------------------------------------------

describe('account reads', () => {
  // TOKA: a contract with a balance; ECHO: a contract without one; USER: a funded EOA (code
  // hash keccak256(0x)); DEAD: nothing at all (code hash 0). Both legs see the same state.
  const table = { [TOKA]: { kind: 'return', data: word(7n) }, [ECHO]: { kind: 'echo' } } as const;
  const balances = { [TOKA]: 5n, [USER]: 10n ** 18n };

  test.each(EVM_VERSIONS)(
    'balance / codeSize / codeHash agree per account kind [%s]',
    async (v) => {
      const script = evscript({ name: 'acct', args: [t.address] }, (s, who) =>
        s.return({ bal: s.balance(who), size: s.codeSize(who), hash: s.codeHash(who) }),
      );
      const outcomes = await expectAgreement(script, [[TOKA], [ECHO], [USER], [DEAD]], table, v, {
        balances,
      });
      const decoded = outcomes.map(
        (o) =>
          decodeFunctionResult({ abi: script.abi, functionName: 'acct', data: o.data }) as {
            bal: bigint;
            size: bigint;
            hash: string;
          },
      );
      expect(decoded.map((d) => d.bal)).toEqual([5n, 0n, 10n ** 18n, 0n]);
      expect(decoded[0]?.size).toBeGreaterThan(0n);
      expect(decoded[2]?.size).toBe(0n);
      expect(decoded[2]?.hash).toBe(keccak256('0x')); // an existing account without code
      expect(decoded[3]?.hash).toBe(`0x${'0'.repeat(64)}`); // a nonexistent account
    },
  );

  test('literal operands and reads inside fns and loops', async () => {
    const script = evscript({ name: 'lits', args: [t.uint256] }, (s, n) => {
      const sizeOf = s.fn('sizeOf', [t.address], (a) => s.codeSize(a));
      const total = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: n }, () => {
        total.set(s.add(total.get(), s.balance(TOKA)));
      });
      return s.return({ total: total.get(), size: sizeOf(ECHO), hash: s.codeHash(USER) });
    });
    await expectAgreement(script, [[0n], [3n]], table, 'cancun', { balances });
  });

  test("the script's own balance (SELFBALANCE) equals BALANCE of its address", async () => {
    const script = evscript({ name: 'mine', args: [t.address] }, (s, self) =>
      s.return({ mine: s.balance(s.env('address')), viaArg: s.balance(self) }),
    );
    const [out] = await expectAgreement(script, [[SCRIPT_ADDRESS]], {}, 'cancun', {
      balances: { [SCRIPT_ADDRESS.toLowerCase()]: 42n },
    });
    const decoded = decodeFunctionResult({
      abi: script.abi,
      functionName: 'mine',
      data: out?.data ?? '0x',
    });
    expect(decoded).toEqual({ mine: 42n, viaArg: 42n });
  });

  // The interpreter cannot see the compiled runtime, so `MockChain.account` hands it over for the
  // script's own address — per output, since the optimized twin's runtime differs.
  test("the script's own code size / hash match its runtime (default and optimized)", async () => {
    const script = evscript({ name: 'me', args: [] }, (s) => {
      const self = s.env('address');
      return s.return({ size: s.codeSize(self), hash: s.codeHash(self) });
    });
    for (const optimize of [false, true]) {
      const compiled = compile(script, { optimize });
      const calldata = encodeFunctionData({ abi: compiled.abi, functionName: 'me' });
      // oxlint-disable-next-line no-await-in-loop -- two sequential runs
      const fromEvm = await execRuntime(compiled.runtimeBytecode, calldata);
      const fromInterp = interpret(script.ir, [], {
        ...chainOf({}),
        account: (address) =>
          address === SCRIPT_ADDRESS.toLowerCase() ? { code: compiled.runtimeBytecode } : undefined,
      }).outcome;
      expect(fromEvm.success).toBe(true);
      expect(fromInterp.data).toBe(fromEvm.data);
      const decoded = decodeFunctionResult({
        abi: compiled.abi,
        functionName: 'me',
        data: fromEvm.data,
      });
      expect(decoded.size).toBe(BigInt((compiled.runtimeBytecode.length - 2) / 2));
      expect(decoded.hash).toBe(keccak256(compiled.runtimeBytecode));
    }
  });

  // Deployless: the script runs at a fresh CREATEd address, whose balance is 0 even when the
  // state-override address is funded — the ENV_FRAME_DEPENDENT note on s.balance(s.env('address')).
  test('deployless frame: the self balance is the created address balance', async () => {
    const script = evscript({ name: 'mine', args: [] }, (s) =>
      s.return({ mine: s.balance(s.env('address')) }),
    );
    const compiled = compile(script);
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: 'mine' });
    const res = await execRuntimeDeployless(compiled.initBytecode, calldata, {
      balances: { [SCRIPT_ADDRESS]: 42n },
    });
    expect(res.success).toBe(true);
    expect(
      decodeFunctionResult({ abi: compiled.abi, functionName: 'mine', data: res.data }),
    ).toEqual({ mine: 0n });
  });
});
