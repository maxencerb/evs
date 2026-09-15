/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — checked arithmetic (boundary matrix), word ops, env ops.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { chainOf, expectAgreement, panicData } from '../../test/harness/differential.js';
import {
  CALLER_ADDRESS,
  DEPLOYLESS_WRAPPER_ADDRESS,
  execRuntimeDeployless,
  SCRIPT_ADDRESS,
} from '../../test/harness/evm.js';
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
