/**
 * Type tests — `interpret()` typed from the script: passing the script (or its compiled
 * artifact) types `args` as the positional tuple `readContract` takes and `outcome.values` as
 * the record it returns; a bare `ScriptIr` keeps untyped args and values. Typecheck only.
 */

import type { Abi, ContractFunctionArgs, ContractFunctionName, ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { evscript, type EvsScript } from '../builder/script.js';
import { compile, type CompiledEvsScript } from '../compile.js';
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

test('a wrong argument or chain is reported where it is, not as a ScriptIr shape error', () => {
  // Each `@ts-expect-error` sits on the line of the bad value, so these fail if the error moves
  // back to the whole call — where an overloaded `interpret` put it, naming the script "missing
  // the following properties from type 'ScriptIr'" instead of the value (e.g. "Type 'string' is
  // not assignable to type 'bigint'"). The result keeps the script's types all the same.
  const result = interpret(
    double,
    [
      // @ts-expect-error — a string for the uint256
      'nope',
    ],
    chain,
  );
  expectTypeOf(result).toEqualTypeOf<InterpResult<{ y: bigint }>>();
  interpret(
    mixed,
    [
      '0x0000000000000000000000000000000000000001',
      7,
      // @ts-expect-error — the struct arg is missing its `live` member
      { amount: 5n },
      [1n],
    ],
    chain,
  );
  interpret(
    double,
    // @ts-expect-error — a missing argument flags the args tuple
    [],
    chain,
  );
  interpret(
    double,
    [21n],
    // @ts-expect-error — a chain without `staticcall` flags the chain
    {},
  );
});

test('a bare ScriptIr (or a wide script type) keeps untyped args and values', () => {
  expectTypeOf(interpret(double.ir, ['anything'], chain)).toEqualTypeOf<InterpResult>();
  expectTypeOf(interpret(ir, [1n, 'x'], chain)).toEqualTypeOf<InterpResult>();

  const fromWide = interpret(wide, [1n, 'x'], chain);
  if (fromWide.outcome.kind === 'return') {
    expectTypeOf(fromWide.outcome.values).toEqualTypeOf<Record<string, unknown>>();
  }
});

test('a wrapper generic in its script type or ABI still compiles (as on 0.3.0)', () => {
  // `args` resolves from the constraint's ABI (wide `Abi` → `readonly unknown[]`), not from an
  // unresolvable conditional on the type parameter. The script type parameters are the point.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a generic wrapper is the case under test
  function runScript<S extends EvsScript>(s: S, args: readonly unknown[]) {
    return interpret(s, args, chain);
  }
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a generic wrapper is the case under test
  function runShape<S extends { readonly ir: ScriptIr; readonly abi: Abi }>(
    s: S,
    args: readonly unknown[],
  ) {
    return interpret(s, args, chain);
  }
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a generic wrapper is the case under test
  function runLiteral<S extends EvsScript>(s: S) {
    return interpret(s, [1n], chain);
  }
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a generic wrapper is the case under test
  function runCompiled<S extends CompiledEvsScript>(s: S, args: readonly unknown[]) {
    return interpret(s, args, chain);
  }
  function runAbi<const abi extends Abi>(
    s: { readonly ir: ScriptIr; readonly abi: abi },
    args: ContractFunctionArgs<abi, 'view', ContractFunctionName<abi, 'view'>>,
  ) {
    return interpret(s, args, chain);
  }
  expectTypeOf(runScript(double, [21n])).toEqualTypeOf<InterpResult>();
  expectTypeOf(runShape(double, [21n])).toEqualTypeOf<InterpResult>();
  expectTypeOf(runLiteral(double)).toEqualTypeOf<InterpResult>();
  expectTypeOf(runCompiled(compile(double), [21n])).toEqualTypeOf<InterpResult>();
  expectTypeOf(runAbi(double, [21n])).toEqualTypeOf<InterpResult<{ y: bigint }>>();
});

test('a union of scripts with different ABIs is rejected, not checked against either', () => {
  const either = Math.random() > 0.5 ? double : noArgs;
  // @ts-expect-error — `[]` fits `noArgs` but not `double`; the union must agree on one ABI
  interpret(either, [], chain);
  // @ts-expect-error — and `[21n]` fits `double` but not `noArgs`
  interpret(either, [21n], chain);
  // each member on its own is still typed from its ABI
  expectTypeOf(interpret(noArgs, [], chain)).toEqualTypeOf<InterpResult<{ ts: bigint }>>();
});
