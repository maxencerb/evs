/**
 * `builder/script/builder.ts` — the builder surface: the `s.fn` types, `ScriptBuilder`, and
 * `makeBuilder`, the typed facade over the untyped `Recorder` engine.
 */

import type {
  EvsType,
  ArgSpec,
  EvsErrorType,
  LitOf,
  IntoExpr,
  TupleType,
  NumericType,
  OrderedType,
  UintType,
  BitsType,
  ArrayType,
  ArrayElemOf,
  ArgsInput,
  NormalizeArgs,
  NoProtoKey,
} from '../../core/types.js';
import type { Expr } from '../../core/types/expr.js';
import type { Recorder } from '../expr.js';
import type {
  ReadVerb,
  TryReadVerb,
  CallVerb,
  TryCallVerb,
  WriteVerb,
  TryWriteVerb,
} from './calls.js';
import type { ArgHandle, LabelCarrier, ThrowArgs } from './evscript.js';
import type {
  AnyTuple,
  AnyMutArray,
  IntoMember,
  IntoValue,
  LitValue,
  MemrefHandle,
  MemrefOperand,
  StagedLiteral,
  Cell,
  MutArray,
  TupleInit,
  Tuple,
  EnvKind,
  EnvTypeOf,
  EncodeValue,
  PackedValue,
  LoopCtl,
  TupleArrayTag,
  TupleArrayElemHandle,
  ReturnValue,
  NonEmptyReturn,
  ScriptReturn,
} from './handles.js';

// ---------------------------------------------------------------------------
// user functions
// ---------------------------------------------------------------------------

/**
 * What an `s.fn` body may return (widened by issue #5 ask #1): a single {@link Expr}, a single
 * {@link Tuple}/{@link MutArray} handle (a composite/array result — byte-identical IR to `.expr()`),
 * a readonly list of those (the `[many]` shape), or void. `s.fn` PARAMS accept every `EvsType`
 * like script args do — a composite (`t.struct`/`t.tuple`) param arrives in the body as a
 * {@link Tuple} handle (issue #37), a composite array / scalar as an {@link Expr}.
 */
export type FnReturn = Expr | AnyTuple | AnyMutArray | readonly FnResult[] | void;
/** One element of an `s.fn` body's `[many]`-shape return. */
export type FnResult = Expr | AnyTuple | AnyMutArray;

/**
 * One fn result → the handle the CALL SITE receives, recovering the precise `EvsType` from the
 * result's static form and applying {@link ArgHandle} (the single `valueHandle`-parity dispatch —
 * the former file-private `HandleOfType` was character-for-character the same conditional).
 * CRUCIAL: this must agree with the runtime `fnCall` `wrap` (which dispatches on the RESULT TYPE,
 * not the body's static form), so a body that returns `s.tuple(...).expr()` (an `Expr<tuple>`) and
 * one that returns the bare `Tuple` both yield a `Tuple<C>` at the call site — and an array result
 * (`Expr<tuple[]>`, `MutArray`) yields an `Expr`.
 */
export type RebuildFnResult<r> =
  r extends Expr<infer t>
    ? ArgHandle<t>
    : r extends { expr(): Expr<infer c extends EvsType> }
      ? ArgHandle<c>
      : never;

// RebuildExprs: the `[many]` list → element-wise rebuild; a single Expr/Tuple/MutArray → its
// rebuilt call-site handle (via the result TYPE, matching the runtime); void → void.
export type RebuildExprs<r extends FnReturn> = r extends readonly FnResult[]
  ? { readonly [i in keyof r]: RebuildFnResult<r[i]> }
  : r extends Expr | AnyTuple | AnyMutArray
    ? RebuildFnResult<r>
    : void;

/**
 * The body-callback param tuple for an `s.fn`: each param as its {@link ArgHandle} (a plain
 * tuple/struct param → a {@link Tuple} handle, else an {@link Expr} — the same `valueHandle`
 * dispatch as script args, issue #37), LABELED by its surfaced name (issue #9) — homomorphic over
 * the {@link LabelCarrier} type parameter `L` (the only way to synthesize tuple/param labels), with
 * the element types from the parallel `specs`.
 */
type FnArgHandles<
  specs extends readonly ArgSpec[],
  L extends readonly unknown[] = LabelCarrier<specs>,
> = {
  [i in keyof L]: i extends keyof specs ? ArgHandle<Extract<specs[i]['type'], EvsType>> : never;
};

/**
 * The call-site signature of an {@link EvsFn}: each param as an {@link IntoMember} — an
 * {@link IntoExpr} for a scalar, an {@link IntoArray} for an array, an {@link IntoTuple} (a `Tuple`
 * handle or a literal object) for a composite param — LABELED by its surfaced name (a
 * {@link namedArg} name, or the `arg{i}` fallback for a bare param — issue #9). `IntoMember` is the
 * type-level mirror of the runtime `coerceToId` acceptance that fn call args go through. The
 * labels come from the {@link LabelCarrier} type parameter `L`; the element types from `params`.
 */
export type EvsFn<
  params extends readonly ArgSpec[],
  r extends FnReturn,
  L extends readonly unknown[] = LabelCarrier<params>,
> = (
  ...args: {
    [i in keyof L]: i extends keyof params
      ? IntoMember<Extract<params[i]['type'], EvsType>>
      : never;
  }
) => RebuildExprs<r>;

// ---------------------------------------------------------------------------
// the operands of a two-operand operator
// ---------------------------------------------------------------------------

/**
 * The first operand of `s.add(a, b)` and the other two-operand operators (and the first branch
 * of `s.select`). One operand is an `Expr` and gives the operation its type; the other is
 * checked against that type, never used to infer it. So the operator has two type parameters,
 * each inferred from one operand only: `a` from the first when it is an `Expr`, `b` from the
 * second. A literal first operand infers no `a` (it stays `never`, its default) and is checked
 * against `b`.
 *
 * Inferring one type parameter from both operands would give two `Expr`s of different types
 * their union, which type-checks and then throws at recording.
 *
 * With no `Expr` at all (`a` and `b` both `never`) the operand meets {@link ExprNeeded}. The
 * two branches are spelled out, not one union with an optional member: the checker prints the
 * result of a conditional type in full, where it would print a union by this alias's name. The
 * bare handle is left out of that branch, where it could only be `MemrefHandle<never>`: the
 * inference of `a` reads both branches, so a handle still gives `a` its type.
 */
export type FirstOperand<
  a extends EvsType,
  b extends EvsType,
  kind extends OperandKind = 'operand',
> = [a | b] extends [never]
  ? Expr<a> | ExprNeeded<kind>
  : Expr<a> | BareHandle<a, kind> | OperandLiteral<b, kind>;

/**
 * The second operand, see {@link FirstOperand}: checked against the first operand's type when
 * that one is an `Expr` (an `Expr` of another type is an error here, as `rhs` is in the method
 * form), else the `Expr` that types the operation.
 */
export type SecondOperand<
  a extends EvsType,
  b extends EvsType,
  kind extends OperandKind = 'operand',
> = [a] extends [never]
  ? [b] extends [never]
    ? Expr<b> | ExprNeeded<kind>
    : Expr<b> | BareHandle<b, kind>
  : CheckedOperand<a, kind>;

/**
 * What the operands belong to: a `'branch'` of `s.select` is named as such in
 * {@link ExprNeeded}; `s.eq` / `s.neq` (`'equality'`) and `s.select`'s branches also take a bare
 * handle ({@link BareHandle}) and a struct or array literal with staged members
 * ({@link StagedLiteral}), as the recorder does.
 */
export type OperandKind = 'operand' | 'branch' | 'equality';

/**
 * The bare `Tuple` / `MutArray` handles `s.eq` / `s.neq` and `s.select`'s branches take for
 * their memref, as the recorder does: a handle types the operation like the `Expr` of its
 * `expr()`. `never` for every other operator, which takes the memref itself (`handle.expr()`).
 */
export type BareHandle<t extends EvsType, kind extends OperandKind> = kind extends 'operand'
  ? never
  : MemrefHandle<t>;

/**
 * The operand checked against the other operand's type `t` ({@link SecondOperand}): an
 * {@link IntoExpr} for an arithmetic, ordering or logic operator, a {@link MemrefOperand} for
 * equality and `s.select`. `t` is behind `NoInfer`, and around the whole memref operand, not
 * inside it: inference stops there instead of walking the branches of its conditional types
 * (struct literals, tuple arrays), which cost a word `s.select` some 8,000 instantiations.
 */
type CheckedOperand<t extends EvsType, kind extends OperandKind> = kind extends 'operand'
  ? IntoExpr<NoInfer<t>>
  : NoInfer<MemrefOperand<t>>;

/** The literal first operand checked against the second's type `t` ({@link FirstOperand}): a
 *  host literal, or for equality and `s.select` a struct or array literal whose members may be
 *  staged. `NoInfer` as in {@link CheckedOperand}. */
type OperandLiteral<t extends EvsType, kind extends OperandKind> = kind extends 'operand'
  ? LitOf<NoInfer<t>>
  : NoInfer<StagedLiteral<t>>;

/**
 * The check on a callback the builder runs while it records (`s.if`, `s.while`, `s.for`,
 * `s.forEach`), the type-level mirror of `assertSyncCallback`: a callback that returns a promise
 * (an async function) or an iterator (a generator function) gets the message as a required key,
 * since nothing after its first `await` is recorded and a generator's body does not run. Every
 * other result (nothing, `undefined`, an `Expr`, a handle, `any`) is `unknown`, a no-op in the
 * `(() => r) & SyncCallback<r>` parameter, so the callback infers as before.
 */
export type SyncCallback<r> = 0 extends 1 & r
  ? unknown
  : [Extract<r, { then(...args: never): unknown }>] extends [never]
    ? [Extract<r, { next(...args: never): unknown }>] extends [never]
      ? unknown
      : {
          readonly 'evs: the callback returns an iterator (a generator function) — the builder runs it once, synchronously, and a generator body does not run when called: use a plain function': never;
        }
    : {
        readonly 'evs: the callback returns a Promise (an async function) — the builder runs it once, synchronously, so nothing after its first await is recorded: await your data before evscript() and use a plain function': never;
      };

/**
 * What an operand is checked against when no operand is an `Expr`: the recording-time
 * TYPE_MISMATCH's text, a string type no operand has, so tsc's error says what to write.
 */
export type ExprNeeded<kind extends OperandKind> =
  `at least one ${kind extends 'branch' ? 'branch' : 'operand'} must be an Expr — type a literal with s.lit(type, value)`;

// ---------------------------------------------------------------------------
// the builder (full surface)
// ---------------------------------------------------------------------------

export interface ScriptBuilder<
  // the script's DECLARED custom errors (issue #15): `s.throw` only accepts members of this
  // tuple, so throwing an undeclared error is a type error at the site. Wide default keeps
  // pre-#15 `ScriptBuilder` references compiling (and accepts any error, backstopped at
  // record time).
  errs extends readonly EvsErrorType[] = readonly EvsErrorType[],
> {
  // values & state
  // a word, `string` or `bytes` takes a constant; a struct or an array what the coercion takes
  // (staged members and elements, a handle of the type). A struct comes back as a `Tuple`.
  // `value` is checked against `type`, never used to infer it: `NoInfer` around the whole type
  // stops inference before the branches of `LitValue` (see `CheckedOperand`)
  lit<const t extends EvsType>(type: t, value: NoInfer<LitValue<t>>): ArgHandle<t>;
  // the cell's type is `type`: `init` is checked against it, never used to infer it
  let<const t extends EvsType>(type: t, init: NoInfer<IntoValue<t>>): Cell<t>;
  // a bare `Tuple` / `MutArray` handle types the cell like the `Expr` of its `expr()`
  let<t extends EvsType>(init: Expr<t> | MemrefHandle<t>): Cell<t>;
  // `e` is any value type: a word, `string`/`bytes`, an array (dynamic or fixed-size, any
  // depth), or a `tuple`/tuple-array descriptor. `{ fixed: true }` with a LITERAL length `n`
  // allocates a fixed-size `e[n]` (its length is part of the type — `expr()` is `Expr<e[n]>`).
  newArray<const e extends EvsType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>;
  newArray<const e extends EvsType, const n extends number>(
    elem: e,
    length: n,
    opts: { readonly fixed: true },
  ): MutArray<e, n>;
  // tuple/struct allocator: `init` is a partial, name-keyed (struct) or positional
  // (t.tuple) record of members; omitted members default to zero. Returns a `Tuple` handle.
  // (a tuple ARRAY is built with s.newArray or given as a literal: `type` is a plain tuple)
  tuple<const c extends TupleType & { readonly type: 'tuple' }>(
    type: c,
    init?: TupleInit<c>,
  ): Tuple<c>;
  env<const k extends EnvKind>(kind: k): Expr<EnvTypeOf<k>>;
  // address/caller → Expr<'address'>; others → Expr<'uint256'>
  // account state of any address (Solidity's `a.balance` / `a.code.length` / `a.codehash`):
  // BALANCE in wei, EXTCODESIZE, and EXTCODEHASH (zero for an account that does not exist).
  // s.balance(s.env('address')) is the script's own balance (SELFBALANCE, frame-dependent).
  balance(account: IntoExpr<'address'>): Expr<'uint256'>;
  codeSize(account: IntoExpr<'address'>): Expr<'uint256'>;
  codeHash(account: IntoExpr<'address'>): Expr<'bytes32'>;

  // ops (free-function mirrors of the Expr methods; same semantics — checked unless `wrapping…`).
  // A two-operand one takes its type from the operand that is an Expr (≥1 is), the first when
  // both are, and checks the other against it: see {@link FirstOperand}. Its result is of that
  // type (`a | b`: one of the two is `never`, or they are the same), behind `NoInfer` so that
  // the type expected of the result is never what gives an operand-less parameter its type.
  add<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  sub<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  mul<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  div<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  mod<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  // checked `**` (the base must be an Expr: its type is the result type); exponent unsigned
  pow<t extends NumericType>(
    base: Expr<t>,
    exponent: IntoExpr<'uint256'> | Expr<UintType>,
  ): Expr<t>;
  // full-precision (a + b) % n / (a · b) % n over uint256; Panic 0x12 on n == 0
  addmod(
    a: IntoExpr<'uint256'>,
    b: IntoExpr<'uint256'>,
    modulus: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  mulmod(
    a: IntoExpr<'uint256'>,
    b: IntoExpr<'uint256'>,
    modulus: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  // FullMath ⌊a · b / d⌋ / ⌈a · b / d⌉ over uint256 (512-bit intermediate); Panic 0x12 on d == 0,
  // Panic 0x11 when the quotient overflows
  mulDiv(
    a: IntoExpr<'uint256'>,
    b: IntoExpr<'uint256'>,
    denominator: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  mulDivRoundingUp(
    a: IntoExpr<'uint256'>,
    b: IntoExpr<'uint256'>,
    denominator: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  // wrapping (solc `unchecked`) add / sub / mul: modulo 2^N of t, never a Panic
  wrappingAdd<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  wrappingSub<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  wrappingMul<a extends NumericType = never, b extends NumericType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  // ordering — numeric, plus address / bytesN as unsigned words
  lt<a extends OrderedType = never, b extends OrderedType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  gt<a extends OrderedType = never, b extends OrderedType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  lte<a extends OrderedType = never, b extends OrderedType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  gte<a extends OrderedType = never, b extends OrderedType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  // memrefs: hash equality, and a bare Tuple / MutArray handle stands for its memref
  eq<a extends EvsType = never, b extends EvsType = never>(
    a: FirstOperand<a, b, 'equality'>,
    b: SecondOperand<a, b, 'equality'>,
  ): Expr<'bool'>;
  neq<a extends EvsType = never, b extends EvsType = never>(
    a: FirstOperand<a, b, 'equality'>,
    b: SecondOperand<a, b, 'equality'>,
  ): Expr<'bool'>;
  and<a extends 'bool' = never, b extends 'bool' = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  or<a extends 'bool' = never, b extends 'bool' = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<'bool'>;
  not(a: IntoExpr<'bool'>): Expr<'bool'>;
  // bitwise, on the bits of a uintN / intN / bytesN (an intN's are its two's complement)
  bitAnd<a extends BitsType = never, b extends BitsType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  bitOr<a extends BitsType = never, b extends BitsType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  bitXor<a extends BitsType = never, b extends BitsType = never>(
    a: FirstOperand<a, b>,
    b: SecondOperand<a, b>,
  ): Expr<NoInfer<a | b>>;
  bitNot<t extends BitsType>(a: Expr<t>): Expr<t>;
  shl<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>; // SAR on intN

  // ABI encoding + hashing (issue #17, amended by #24). `keccak256` hashes the
  // STANDARD encoding — `keccak256(abi.encode(...))` — of any encodable values (a single
  // bytes/string value is hashed directly, Solidity's `keccak256(bytes)`); the non-standard
  // packed hash is the explicit composition s.keccak256(s.encodePacked(…)).
  encode(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes'>;
  encodePacked(...values: [PackedValue, ...PackedValue[]]): Expr<'bytes'>;
  keccak256(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes32'>;

  // control flow (combinators). A callback runs once, synchronously, while the script records:
  // an async or generator callback is refused (`SyncCallback`)
  if<r1 = void, r2 = void>(
    cond: IntoExpr<'bool'>,
    then: (() => r1) & SyncCallback<r1>,
    otherwise?: (() => r2) & SyncCallback<r2>,
  ): void;
  while<r = void>(
    cond: () => IntoExpr<'bool'>,
    body: ((loop: LoopCtl) => r) & SyncCallback<r>,
  ): void;
  // `range.type` is optional (issue #12): the first overload matches a type-less range and
  // types the counter as uint256; the explicit-type overload keeps the pre-#12 behaviour.
  for<r = void>(
    range: {
      type?: undefined;
      from: IntoExpr<'uint256'>;
      until: IntoExpr<'uint256'>;
      step?: IntoExpr<'uint256'>;
    },
    body: ((i: Expr<'uint256'>, loop: LoopCtl) => r) & SyncCallback<r>,
  ): void;
  // (the counter's type is `range.type`: the bounds are checked against it)
  for<const t extends NumericType, r = void>(
    range: {
      type: t;
      from: IntoExpr<NoInfer<t>>;
      until: IntoExpr<NoInfer<t>>;
      step?: IntoExpr<NoInfer<t>>;
    },
    body: ((i: Expr<t>, loop: LoopCtl) => r) & SyncCallback<r>,
  ): void;
  // forEach over an array value (issue #12): the counter loop with `until` = the array's
  // length (snapshot ONCE) and `elem` = the bounds-checked `array.at(i)` — a `tuple[]` array
  // hands the body a `Tuple` element handle, a `tuple[][]` an `Expr<tuple[]>` element, a
  // string-element array an `Expr` of the element (the same {@link TupleArrayElemHandle}
  // dispatch as the `.at` augmentation; a plain `tuple` is a compile error, mirrored at record
  // time). Staged handles only: a MutArray iterates through its `.expr()` memref. The element
  // load is always recorded; a body that never reads `elem` leaves it dead and the compile-time
  // DCE pass (ir/dce.ts) drops it, bounds check included.
  forEach<C extends TupleType & { readonly type: TupleArrayTag }, r = void>(
    array: Expr<C>,
    body: ((elem: TupleArrayElemHandle<C>, i: Expr<'uint256'>, loop: LoopCtl) => r) &
      SyncCallback<r>,
  ): void;
  forEach<a extends ArrayType, r = void>(
    array: Expr<a>,
    body: ((elem: Expr<ArrayElemOf<a>>, i: Expr<'uint256'>, loop: LoopCtl) => r) & SyncCallback<r>,
  ): void;
  // the result's type is the branch's that is an Expr or a bare handle (≥1 is), the first when
  // both are: the other branch is checked against it (see {@link FirstOperand}). A struct result
  // is a `Tuple` handle, like every struct value ({@link ArgHandle}).
  select<a extends EvsType = never, b extends EvsType = never>(
    cond: IntoExpr<'bool'>,
    a: FirstOperand<a, b, 'branch'>,
    b: SecondOperand<a, b, 'branch'>,
  ): ArgHandle<NoInfer<a | b>>;

  // calls — SPLIT BY MUTABILITY (issue #1). Each verb carries the same three
  // struct-aware overloads (the `struct` opt-in from issue #5 ask #2), differing only in the
  // mutability bucket its `functionName`/arg/output handles are filtered by:
  //   read     / tryRead     → STATICCALL of view/pure
  //   call     / tryCall     → CALL of nonpayable/payable        (non-static frame, NO rollback)
  //                            + the `revertReturns` opt-in (issue #35: decode the REVERT payload)
  //   simulate / trySimulate → CALL of nonpayable/payable        (write dry-run, state rolled back)
  read: ReadVerb;
  tryRead: TryReadVerb;
  call: CallVerb;
  tryCall: TryCallVerb;
  simulate: WriteVerb;
  trySimulate: TryWriteVerb;

  // functions — `params` accepts the same shorthand as `evscript` args (issue #9): a
  // bare `t.*` type, a single `namedArg(...)`, or a `readonly` list mixing named/bare. Body params
  // are labeled by name and typed like script args: a composite (`t.struct`/`t.tuple`) param is
  // a `Tuple` handle, a composite array / scalar an `Expr` (issue #37).
  fn<const params extends ArgsInput, const r extends FnReturn>(
    name: string,
    params: params,
    body: (...args: FnArgHandles<NormalizeArgs<params>>) => r,
  ): EvsFn<NormalizeArgs<params>, r>;

  // custom errors (issue #15) — revert with `selector ‖ abi.encode(args)`. Only DECLARED
  // errors (the def's `errors: [...]`) are accepted; args are a required name-keyed record
  // (all params named), a positional tuple (any bare param), or absent (zero params).
  // Recording continues after a throw (it is usually conditional, inside s.if); statements
  // recorded after an UNCONDITIONAL throw in the same block are dead in the emitted program.
  throw<const e extends errs[number]>(error: e, ...args: ThrowArgs<e>): void;

  // return — accepts an `Expr` OR a `Tuple` handle directly per component (the
  // `.expr()` on a tuple is optional; the bare handle returns the same memref). The record must
  // name at least one value (`NonEmptyReturn`, issue #66): an empty one ABI-encodes to 0x.
  // A literal `__proto__` key is a type error (`NoProtoKey`): JS never makes it a member.
  return<const ret extends Record<string, ReturnValue>>(
    values: ret & NonEmptyReturn<ret> & NoProtoKey<ret>,
  ): ScriptReturn<ret>;
}

// ---------------------------------------------------------------------------
// the facade (typed surface over the untyped Recorder engine)
// ---------------------------------------------------------------------------

export function makeBuilder(r: Recorder): ScriptBuilder {
  // the six calling verbs (issue #1) — all route through the one recorder `subcall`, differing
  // in the call kind (frame/state semantics) and, for the try variants, the success/value wrap.
  type CallKind = 'static' | 'call' | 'simulate';
  const strictVerb = (kind: CallKind) => (p: unknown) => r.subcall(p, 'strict', kind).value;
  const tryVerb = (kind: CallKind) => (p: unknown) => {
    const res = r.subcall(p, 'try', kind);
    return Object.freeze({ success: res.success, value: res.value });
  };

  const builder = {
    lit: (type: unknown, value: unknown) => r.lit(type, value),
    let: (a: unknown, b?: unknown) => r.letCell(a, b),
    newArray: (elem: unknown, length: unknown, opts?: unknown) => r.newArray(elem, length, opts),
    tuple: (type: unknown, init?: unknown) => r.tuple(type, init),
    env: (kind: unknown) => r.env(kind),
    balance: (account: unknown) => r.accountOp('balance', account, 's.balance()'),
    codeSize: (account: unknown) => r.accountOp('codesize', account, 's.codeSize()'),
    codeHash: (account: unknown) => r.accountOp('codehash', account, 's.codeHash()'),

    add: (a: unknown, b: unknown) => r.bin('add', a, b, 's.add()'),
    sub: (a: unknown, b: unknown) => r.bin('sub', a, b, 's.sub()'),
    mul: (a: unknown, b: unknown) => r.bin('mul', a, b, 's.mul()'),
    div: (a: unknown, b: unknown) => r.bin('div', a, b, 's.div()'),
    mod: (a: unknown, b: unknown) => r.bin('mod', a, b, 's.mod()'),
    pow: (a: unknown, e: unknown) => r.bin('pow', a, e, 's.pow()'),
    addmod: (a: unknown, b: unknown, n: unknown) => r.modArithOp('addmod', a, b, n, 's.addmod()'),
    mulmod: (a: unknown, b: unknown, n: unknown) => r.modArithOp('mulmod', a, b, n, 's.mulmod()'),
    mulDiv: (a: unknown, b: unknown, d: unknown) => r.modArithOp('muldiv', a, b, d, 's.mulDiv()'),
    mulDivRoundingUp: (a: unknown, b: unknown, d: unknown) =>
      r.modArithOp('muldivup', a, b, d, 's.mulDivRoundingUp()'),
    wrappingAdd: (a: unknown, b: unknown) => r.bin('wrapadd', a, b, 's.wrappingAdd()'),
    wrappingSub: (a: unknown, b: unknown) => r.bin('wrapsub', a, b, 's.wrappingSub()'),
    wrappingMul: (a: unknown, b: unknown) => r.bin('wrapmul', a, b, 's.wrappingMul()'),
    lt: (a: unknown, b: unknown) => r.bin('lt', a, b, 's.lt()'),
    gt: (a: unknown, b: unknown) => r.bin('gt', a, b, 's.gt()'),
    lte: (a: unknown, b: unknown) => r.bin('lte', a, b, 's.lte()'),
    gte: (a: unknown, b: unknown) => r.bin('gte', a, b, 's.gte()'),
    eq: (a: unknown, b: unknown) => r.bin('eq', a, b, 's.eq()'),
    neq: (a: unknown, b: unknown) => r.bin('neq', a, b, 's.neq()'),
    and: (a: unknown, b: unknown) => r.bin('and', a, b, 's.and()'),
    or: (a: unknown, b: unknown) => r.bin('or', a, b, 's.or()'),
    not: (a: unknown) => r.notOp(a, 's.not()'),
    bitAnd: (a: unknown, b: unknown) => r.bin('bitand', a, b, 's.bitAnd()'),
    bitOr: (a: unknown, b: unknown) => r.bin('bitor', a, b, 's.bitOr()'),
    bitXor: (a: unknown, b: unknown) => r.bin('bitxor', a, b, 's.bitXor()'),
    bitNot: (a: unknown) => r.bitNotOp(a, 's.bitNot()'),
    shl: (a: unknown, bits: unknown) => r.bin('shl', a, bits, 's.shl()'),
    shr: (a: unknown, bits: unknown) => r.bin('shr', a, bits, 's.shr()'),

    encode: (...values: unknown[]) => r.encodeOp('abi', values, 's.encode()'),
    encodePacked: (...values: unknown[]) => r.encodeOp('packed', values, 's.encodePacked()'),
    keccak256: (...values: unknown[]) => r.keccakOp(values, 's.keccak256()'),

    if: (cond: unknown, then: unknown, otherwise?: unknown) => {
      r.ifStmt(cond, then, otherwise);
    },
    while: (cond: unknown, body: unknown) => {
      r.whileStmt(cond, body);
    },
    for: (range: unknown, body: unknown) => {
      r.forStmt(range, body);
    },
    forEach: (array: unknown, body: unknown) => {
      r.forEachStmt(array, body);
    },
    select: (cond: unknown, a: unknown, b: unknown) => r.select(cond, a, b),

    read: strictVerb('static'),
    tryRead: tryVerb('static'),
    call: strictVerb('call'),
    tryCall: tryVerb('call'),
    simulate: strictVerb('simulate'),
    trySimulate: tryVerb('simulate'),

    fn: (name: unknown, params: unknown, body: unknown) => r.defineFn(name, params, body),

    throw: (error: unknown, ...args: unknown[]) => {
      r.throwStmt(error, args, 's.throw()');
    },

    return: (values: unknown) => r.ret(values),
  };
  // the facade implements the declared `ScriptBuilder` surface; types are enforced at the surface,
  // the engine is dynamic
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return builder as unknown as ScriptBuilder;
}
