/**
 * Type tests — the address / fixed-bytes / string-bytes conversions and byte access: result
 * types (`UintOfBytesN` / `BytesNOfUint` across the width table), the `this`-parameter receiver
 * constraints, ordering on `address` / `bytesN` (methods and the `s.lt` family), and viem's
 * inference of the converted returns. Runs under the vitest `types` project (typecheck only).
 */
import type { ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { compile } from '../compile.js';
import {
  t,
  type BytesNOfUint,
  type conversionHint,
  type ConversionHint,
  type Expr,
  type IntType,
  type NumericReceiver,
  type NumericType,
  type OrderedType,
  type UintOfBytesN,
  type UintType,
} from '../core/types.js';
import { evscript } from './script.js';

test('UintOfBytesN / BytesNOfUint map every width both ways', () => {
  expectTypeOf<UintOfBytesN<'bytes1'>>().toEqualTypeOf<'uint8'>();
  expectTypeOf<UintOfBytesN<'bytes4'>>().toEqualTypeOf<'uint32'>();
  expectTypeOf<UintOfBytesN<'bytes20'>>().toEqualTypeOf<'uint160'>();
  expectTypeOf<UintOfBytesN<'bytes32'>>().toEqualTypeOf<'uint256'>();
  expectTypeOf<BytesNOfUint<'uint8'>>().toEqualTypeOf<'bytes1'>();
  expectTypeOf<BytesNOfUint<'uint24'>>().toEqualTypeOf<'bytes3'>();
  expectTypeOf<BytesNOfUint<'uint256'>>().toEqualTypeOf<'bytes32'>();
  // not a bytesN / uintN → never
  expectTypeOf<UintOfBytesN<'bytes'>>().toEqualTypeOf<never>();
  expectTypeOf<UintOfBytesN<'uint32'>>().toEqualTypeOf<never>();
  expectTypeOf<BytesNOfUint<'int32'>>().toEqualTypeOf<never>();
  expectTypeOf<'address'>().toExtend<OrderedType>();
  expectTypeOf<'bytes7'>().toExtend<OrderedType>();
  expectTypeOf<'bool'>().not.toExtend<OrderedType>();
});

test('conversion result types and receiver constraints', () => {
  evscript(
    {
      name: 'casts',
      args: [t.address, t.uint160, t.bytes4, t.uint64, t.string, t.bytes, t.bytes32],
    },
    (s, a, u160, b4, u64, str, raw, b32) => {
      expectTypeOf(a.asUint160()).toEqualTypeOf<Expr<'uint160'>>();
      expectTypeOf(u160.asAddress()).toEqualTypeOf<Expr<'address'>>();
      expectTypeOf(b4.asUint()).toEqualTypeOf<Expr<'uint32'>>();
      expectTypeOf(u64.asBytesN()).toEqualTypeOf<Expr<'bytes8'>>();
      expectTypeOf(b32.asUint()).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(str.asBytes()).toEqualTypeOf<Expr<'bytes'>>();
      expectTypeOf(raw.asString()).toEqualTypeOf<Expr<'string'>>();
      expectTypeOf(b32.asString()).toEqualTypeOf<Expr<'string'>>();
      expectTypeOf(b4.asString()).toEqualTypeOf<Expr<'string'>>();
      expectTypeOf(str.byteAt(0n)).toEqualTypeOf<Expr<'bytes1'>>();
      expectTypeOf(raw.byteAt(u64.toUint(t.uint256))).toEqualTypeOf<Expr<'bytes1'>>();
      expectTypeOf(raw.slice(4n)).toEqualTypeOf<Expr<'bytes'>>();
      expectTypeOf(str.slice(0n, 3n)).toEqualTypeOf<Expr<'string'>>();

      // @ts-expect-error — only an address converts to uint160 (a uint256 narrows with toUint)
      u64.asUint160();
      // @ts-expect-error — asAddress takes uint256 / bytes32 / uint160, not a narrower uintN
      u64.asAddress();
      // @ts-expect-error — asUint is the bytesN → uintN direction
      u64.asUint();
      // @ts-expect-error — asBytesN is the uintN → bytesN direction
      b4.asBytesN();
      // @ts-expect-error — signed integers have no bytesN twin
      s.lit(t.int32, -1n).asBytesN();
      // @ts-expect-error — a string reinterprets as bytes, not the other way round
      raw.asBytes();
      // @ts-expect-error — asString is for bytes / bytesN
      u64.asString();
      // @ts-expect-error — byteAt is for string / bytes (arrays use .at)
      b32.byteAt(0n);
      // @ts-expect-error — the index is a uint256
      raw.byteAt(s.lit(t.uint8, 0n));
      // @ts-expect-error — slice is for string / bytes
      b4.slice(0n);
      // @ts-expect-error — string has no array .at (read a byte with byteAt)
      str.at(0n);
      return s.return({ ok: s.lit(t.bool, true) });
    },
  );
});

test('toUint / toInt on a non-numeric receiver: the type error names the as* conversion', () => {
  // the `this` type a non-numeric receiver meets is the message itself (tsc prints it in the
  // error; `conversions.test.ts` pins the printed diagnostic)
  expectTypeOf<NumericReceiver<'address', 'toUint'>>().toEqualTypeOf<{
    readonly [conversionHint]: ".toUint(): cannot convert from 'address' — the source must be numeric (uintN/intN) — use .asUint160() first (then .toUint(…))";
  }>();
  expectTypeOf<NumericReceiver<'bytes4', 'toInt'>>().toEqualTypeOf<{
    readonly [conversionHint]: ".toInt(): cannot convert from 'bytes4' — the source must be numeric (uintN/intN) — use .asUint() first (same width, then .toInt(…))";
  }>();
  expectTypeOf<NumericReceiver<'bool', 'toUint'>>().toEqualTypeOf<{
    readonly [conversionHint]: ".toUint(): cannot convert from 'bool' — the source must be numeric (uintN/intN)";
  }>();
  expectTypeOf<NumericReceiver<'uint8[]', 'toInt'>>().toEqualTypeOf<{
    readonly [conversionHint]: ".toInt(): cannot convert from 'uint8[]' — the source must be numeric (uintN/intN)";
  }>();
  // a tuple's runtime text names its JSON descriptor, which the message leaves out
  expectTypeOf<
    ConversionHint<{ readonly type: 'tuple'; readonly components: readonly [] }, 'toUint'>
  >().toEqualTypeOf<'.toUint(): the source must be numeric (uintN/intN)'>();
  // a numeric receiver is itself
  expectTypeOf<NumericReceiver<'uint64', 'toUint'>>().toEqualTypeOf<Expr<'uint64'>>();
  expectTypeOf<NumericReceiver<UintType | IntType, 'toInt'>>().toEqualTypeOf<
    Expr<UintType | IntType>
  >();

  evscript(
    { name: 'hints', args: [t.address, t.bytes4, t.bool, t.uint64, t.int24] },
    (s, a, b4, flag, u64, i24) => {
      // @ts-expect-error — an address converts through .asUint160() first
      a.toUint(t.uint160);
      // @ts-expect-error — a bytesN converts through .asUint() first
      b4.toInt(t.int64);
      // @ts-expect-error — bool has no integer counterpart
      flag.toUint(t.uint8);
      // the hinted routes, and numeric receivers, still infer their target
      expectTypeOf(a.asUint160().toUint(t.uint256)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(b4.asUint().toInt(t.int64)).toEqualTypeOf<Expr<'int64'>>();
      expectTypeOf(u64.toUint(t.uint8)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(i24.toUint('uint256')).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(i24.toInt(t.int256)).toEqualTypeOf<Expr<'int256'>>();
      return s.return({ ok: flag });
    },
  );

  // a generic receiver bounded by the numeric types is accepted; one that admits an address is not
  const widen = <u extends UintType>(x: Expr<u>) => x.toUint(t.uint256);
  expectTypeOf(widen).returns.toEqualTypeOf<Expr<'uint256'>>();
  const signed = <n extends NumericType>(x: Expr<n>) => x.toInt(t.int256);
  expectTypeOf(signed).returns.toEqualTypeOf<Expr<'int256'>>();
  // @ts-expect-error — u may be 'address'
  const loose = <u extends UintType | 'address'>(x: Expr<u>) => x.toUint(t.uint256);
  void loose;
});

test('ordering on address and bytesN, methods and free functions', () => {
  evscript(
    { name: 'order', args: [t.address, t.address, t.bytes4, t.bool] },
    (s, a, b, sel, flag) => {
      expectTypeOf(a.lt(b)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(a.gte('0x0000000000000000000000000000000000000001')).toEqualTypeOf<
        Expr<'bool'>
      >();
      expectTypeOf(s.lt(a, b)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.gt('0x0000000000000000000000000000000000000001', b)).toEqualTypeOf<
        Expr<'bool'>
      >();
      expectTypeOf(sel.lte('0x12345678')).toEqualTypeOf<Expr<'bool'>>();
      // @ts-expect-error — bool has no ordering
      flag.lt(true);
      // @ts-expect-error — nor in the free-function form
      s.lt(flag, true);
      // @ts-expect-error — address vs bytes4: operand types must match
      a.lt(sel);
      // @ts-expect-error — an address literal is a 0x string, not a number
      a.lt(1n);
      return s.return({ ok: s.lit(t.bool, true) });
    },
  );
});

test('viem infers the converted returns', () => {
  const script = evscript({ name: 'symbolOf', args: [t.bytes32, t.address] }, (s, raw, a) =>
    s.return({ symbol: raw.asString(), selector: raw.asUint().asBytesN(), key: a.asUint160() }),
  );
  const { abi } = compile(script);
  expectTypeOf<ReadContractReturnType<typeof abi, 'symbolOf'>>().toEqualTypeOf<{
    symbol: string;
    selector: `0x${string}`;
    key: bigint;
  }>();
});
