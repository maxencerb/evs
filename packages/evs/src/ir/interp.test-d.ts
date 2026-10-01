/**
 * Type tests — `interpret()` typed from the script: passing the script (or its compiled
 * artifact) types `args` as the positional tuple `readContract` takes and `outcome.values` as
 * the record it returns; a bare `ScriptIr` keeps the untyped signature. Typecheck only.
 */

import type { ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { evscript, type EvsScript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type Hex } from '../core/types.js';
import { interpret, type InterpResult, type MockChain } from './interp.js';
import type { ScriptIr } from './nodes.js';

declare const chain: MockChain;
declare const ir: ScriptIr;
declare const wide: EvsScript;

const double = evscript({ name: 'double', args: [t.uint256] }, (s, x) =>
  s.return({ y: x.mul(2n) }),
);

const mixed = evscript(
  {
    name: 'mixed',
    args: [t.address, t.uint8, t.struct({ amount: t.uint128, live: t.bool }), t.array(t.uint256)],
  },
  (s, who, small, pos, list) =>
    s.return({ who, small, amount: pos.amount.get(), live: pos.live.get(), list }),
);

const noArgs = evscript({ name: 'noArgs', args: [] }, (s) => s.return({ ts: s.env('timestamp') }));

test('a script: args are readContract args, values the record readContract returns', () => {
  const result = interpret(double, [21n], chain);
  expectTypeOf(result).toEqualTypeOf<InterpResult<{ y: bigint }>>();
  if (result.outcome.kind === 'return') {
    expectTypeOf(result.outcome.values.y).toEqualTypeOf<bigint>();
    expectTypeOf(result.outcome.data).toEqualTypeOf<Hex>();
  }

  // @ts-expect-error — a wrong argument shape is caught at compile time
  interpret(double, ['nope'], chain);
  // @ts-expect-error — and so is a wrong arity
  interpret(double, [], chain);
});

test('values match readContract inference, including narrow ints, structs and arrays', () => {
  const result = interpret(
    mixed,
    ['0x0000000000000000000000000000000000000001', 7, { amount: 5n, live: true }, [1n, 2n]],
    chain,
    { trace: true, maxSteps: 1_000 },
  );
  if (result.outcome.kind === 'return') {
    expectTypeOf(result.outcome.values).toEqualTypeOf<
      ReadContractReturnType<typeof mixed.abi, 'mixed'>
    >();
    expectTypeOf(result.outcome.values.small).toEqualTypeOf<number>(); // uint8 → number
    expectTypeOf(result.outcome.values.list).toEqualTypeOf<readonly bigint[]>();
  }

  // @ts-expect-error — the struct arg is keyed by member names, like readContract's
  interpret(mixed, ['0x0000000000000000000000000000000000000001', 7, { amount: 5n }, []], chain);
});

test('a zero-arg script takes [] and the compiled artifact types the same way', () => {
  const result = interpret(noArgs, [], chain);
  expectTypeOf(result).toEqualTypeOf<InterpResult<{ ts: bigint }>>();
  // @ts-expect-error — no args expected
  interpret(noArgs, [1n], chain);

  const compiled = compile(double);
  expectTypeOf(interpret(compiled, [21n], chain)).toEqualTypeOf<InterpResult<{ y: bigint }>>();
  // @ts-expect-error — same check through the artifact
  interpret(compiled, ['nope'], chain);
});

test('a bare ScriptIr (or a wide script type) keeps the untyped signature', () => {
  expectTypeOf(interpret(double.ir, ['anything'], chain)).toEqualTypeOf<InterpResult>();
  expectTypeOf(interpret(ir, [1n, 'x'], chain)).toEqualTypeOf<InterpResult>();

  const fromWide = interpret(wide, [1n, 'x'], chain);
  if (fromWide.outcome.kind === 'return') {
    expectTypeOf(fromWide.outcome.values).toEqualTypeOf<Record<string, unknown>>();
  }
});
