/**
 * M5 `builder/script.ts` — the public builder surface: `evscript`, `EvsScript`,
 * `ScriptBuilder`, `Cell`, `MutArray`, `LoopCtl`, `ScriptReturn`.
 *
 * Contract: docs/design/module-interfaces.md §M5 (frozen signatures) + api.md §1/§4–§9.
 * The recording engine (scope stack, handle internals, folding, validation checklist) lives
 * in `builder/expr.ts`; this file owns the frozen types and wires the typed facade onto it.
 */
import type { Abi, AbiParameter, AbiParameterToPrimitiveType } from 'abitype';
import type { ContractFunctionName } from 'viem';

import { buildScriptAbi, type ScriptAbi } from '../abi/artifact.js';
import * as compileModule from '../compile.js';
import type { CompiledEvsScript, CompileOptions } from '../compile.js';
import { EvsInternalError, EvsTypeError } from '../core/errors.js';
import { captureLoc, setLocCapture } from '../core/loc.js';
import type {
  ArgSpec,
  BitsType,
  EvsType,
  Expr,
  IntoExpr,
  LitOf,
  NumericType,
  WordType,
} from '../core/types.js';
import type { ScriptIr } from '../ir/nodes.js';
import { assertV0Type, Recorder } from './expr.js';

// ---------------------------------------------------------------------------
// entry point (api.md §1)
// ---------------------------------------------------------------------------

export interface EvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, Expr> = Record<string, Expr>,
> {
  readonly name: name;
  readonly ir: ScriptIr; // frozen, JSON-serializable
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed value, exists pre-compile
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret>; // sugar for compile()
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

export function evscript<
  const name extends string,
  const args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
>(
  def: { name: name; args: args },
  body: (s: ScriptBuilder<args>) => ScriptReturn<ret>,
  opts?: { locations?: boolean }, // default true: capture source locations
): EvsScript<name, args, ret> {
  const entryLoc = captureLoc();
  if (typeof def !== 'object' || def === null) {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript: def must be { name, args }`, {
      loc: entryLoc,
    });
  }
  if (typeof def.name !== 'string' || !IDENT_RE.test(def.name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `evscript: script name must be a non-empty identifier, got ${JSON.stringify(def.name)}`,
      { loc: entryLoc },
    );
  }
  if (!Array.isArray(def.args)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `evscript "${def.name}": args must be a readonly ArgSpec[] tuple (use arg(name, type))`,
      { loc: entryLoc },
    );
  }
  if (typeof body !== 'function') {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript "${def.name}": body must be a callback`, {
      loc: entryLoc,
    });
  }
  const seen = new Set<string>();
  const argSpecs = def.args.map((spec, i): { name: string; type: EvsType } => {
    const sp = (typeof spec === 'object' && spec !== null ? spec : {}) as {
      name?: unknown;
      type?: unknown;
    };
    if (typeof sp.name !== 'string' || sp.name === '' || !IDENT_RE.test(sp.name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `evscript "${def.name}" arg #${i}: invalid argument name ${JSON.stringify(sp.name)} (must be a non-empty identifier)`,
        { loc: entryLoc },
      );
    }
    if (seen.has(sp.name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `evscript "${def.name}" arg #${i}: duplicate argument name "${sp.name}"`,
        { loc: entryLoc },
      );
    }
    seen.add(sp.name);
    assertV0Type(sp.type, `evscript "${def.name}" arg "${sp.name}"`, entryLoc);
    return { name: sp.name, type: sp.type };
  });

  const locations = opts?.locations ?? true;
  if (!locations) setLocCapture(false); // scoped per recorder; restored below
  let recorder: Recorder;
  let callbackResult: unknown;
  try {
    recorder = new Recorder(def.name, argSpecs, locations ? entryLoc : null);
    const s = makeBuilder<args>(recorder);
    callbackResult = body(s);
  } finally {
    if (!locations) setLocCapture(true);
  }
  const { ir, returns } = recorder.finish(callbackResult);
  // the runtime ABI array is the encode/decode source of truth; the literal type mirrors it
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime↔type agreement is pinned by M3 tests
  const abi = buildScriptAbi(def.name, ir.args, returns) as unknown as ScriptAbi<name, args, ret>;
  const script: EvsScript<name, args, ret> = {
    name: def.name,
    ir,
    abi,
    compile(options?: CompileOptions): CompiledEvsScript<name, args, ret> {
      // namespace access keeps this tolerant of the M9 module landing separately
      const compileFn: unknown = (compileModule as Record<string, unknown>)['compile'];
      if (typeof compileFn !== 'function') {
        throw new EvsInternalError(
          'INTERNAL',
          'compile() is not available — the evs compile module failed to load',
        );
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- M9 frozen signature
      return (compileFn as (sc: unknown, o?: CompileOptions) => CompiledEvsScript<name, args, ret>)(
        script,
        options,
      );
    },
  };
  return Object.freeze(script);
}

// ---------------------------------------------------------------------------
// cells, mutable arrays, loop control (api.md §5)
// ---------------------------------------------------------------------------

export interface Cell<t extends EvsType> {
  readonly type: t;
  get(): Expr<t>; // fresh snapshot at this program point
  set(value: IntoExpr<t>): void;
}

export interface MutArray<e extends WordType> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoExpr<e>): void; // bounds-checked → Panic 0x32
  get(i: IntoExpr<'uint256'>): Expr<e>; // bounds-checked → Panic 0x32
  expr(): Expr<`${e}[]`>; // memref handle to the SAME buffer (reference semantics, documented)
}

export interface LoopCtl {
  break(): void;
  continue(): void;
}

export declare const returnBrand: unique symbol;
export interface ScriptReturn<ret extends Record<string, Expr>> {
  readonly [returnBrand]: ret;
}

// ---------------------------------------------------------------------------
// env (api.md §4)
// ---------------------------------------------------------------------------

export type EnvKind = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';
export type EnvTypeOf<k extends EnvKind> = k extends 'address' | 'caller' ? 'address' : 'uint256';

// ---------------------------------------------------------------------------
// calls (api.md §6)
// ---------------------------------------------------------------------------

export type ViewMutability = 'pure' | 'view';

type ViewFnOf<abi, name> = abi extends Abi
  ? Extract<
      abi[number],
      { readonly type: 'function'; readonly name: name; readonly stateMutability: ViewMutability }
    >
  : never;

// per-parameter union: literal (abitype Register-resolved primitive) OR Expr of that type
export type SubcallInputs<abi extends Abi | readonly unknown[], name extends string> = [
  ViewFnOf<abi, name>,
] extends [never]
  ? readonly unknown[]
  : ViewFnOf<abi, name> extends { readonly inputs: infer inputs extends readonly AbiParameter[] }
    ? {
        readonly [i in keyof inputs]:
          | AbiParameterToPrimitiveType<inputs[i], 'inputs'>
          | Expr<inputs[i]['type'] extends EvsType ? inputs[i]['type'] : never>;
      }
    : readonly unknown[];

export type SubcallOutputs<abi extends Abi | readonly unknown[], name extends string> = [
  ViewFnOf<abi, name>,
] extends [never]
  ? readonly Expr[]
  : ViewFnOf<abi, name> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? {
        readonly [i in keyof outs]: Expr<
          outs[i]['type'] extends EvsType ? outs[i]['type'] : EvsType
        >;
      }
    : readonly Expr[];

// outputs []  → void;  [one] → Expr<one>;  [many] → readonly tuple of Exprs (mirrors viem)
export type UnwrapSingle<outs> = outs extends readonly []
  ? void
  : outs extends readonly [infer one]
    ? one
    : outs;

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends ContractFunctionName<abi, ViewMutability>,
> {
  readonly address: IntoExpr<'address'>;
  readonly abi: abi;
  readonly functionName: name | ContractFunctionName<abi, ViewMutability>; // autocomplete union
  readonly args?: SubcallInputs<abi, name>;
  readonly gas?: IntoExpr<'uint256'>; // optional cap; default forward-all
}

// ---------------------------------------------------------------------------
// user functions (api.md §8)
// ---------------------------------------------------------------------------

export type FnReturn = Expr | readonly Expr[] | void;

// RebuildExprs: Expr<t> → fresh Expr<t>; tuples → fresh tuples; void → void
export type RebuildExprs<r extends FnReturn> =
  r extends Expr<infer tt>
    ? Expr<tt>
    : r extends readonly Expr[]
      ? { readonly [i in keyof r]: r[i] extends Expr<infer tt> ? Expr<tt> : never }
      : void;

export type EvsFn<params extends readonly ArgSpec[], r extends FnReturn> = (
  ...args: { [i in keyof params]: IntoExpr<params[i]['type']> }
) => RebuildExprs<r>;

// ---------------------------------------------------------------------------
// the builder (api.md §4 — full surface)
// ---------------------------------------------------------------------------

export interface ScriptBuilder<args extends readonly ArgSpec[]> {
  readonly args: { readonly [a in args[number] as a['name']]: Expr<a['type']> };

  // values & state
  lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>;
  let<const t extends EvsType>(type: t, init: IntoExpr<t>): Cell<t>;
  let<t extends EvsType>(init: Expr<t>): Cell<t>;
  newArray<const e extends WordType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>;
  env<const k extends EnvKind>(kind: k): Expr<EnvTypeOf<k>>;
  // address/caller → Expr<'address'>; others → Expr<'uint256'>

  // ops (free-function mirrors of the Expr methods; same checked semantics)
  add<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>; // ≥1 operand an Expr
  sub<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  mul<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  div<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  mod<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  lt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  gt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  lte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  gte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  eq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  neq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  and(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>;
  or(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>;
  not(a: IntoExpr<'bool'>): Expr<'bool'>;
  bitAnd<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitOr<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitXor<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitNot<t extends BitsType>(a: Expr<t>): Expr<t>;
  shl<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>;

  // control flow (combinators — api.md §7)
  if(cond: IntoExpr<'bool'>, then: () => void, otherwise?: () => void): void;
  while(cond: () => IntoExpr<'bool'>, body: (loop: LoopCtl) => void): void;
  for<const t extends NumericType>(
    range: { type: t; from: IntoExpr<t>; until: IntoExpr<t>; step?: IntoExpr<t> },
    body: (i: Expr<t>, loop: LoopCtl) => void,
  ): void;
  select<t extends EvsType>(cond: IntoExpr<'bool'>, a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;

  // calls (api.md §6)
  call<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): UnwrapSingle<SubcallOutputs<abi, name>>;
  tryCall<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): { readonly success: Expr<'bool'>; readonly value: UnwrapSingle<SubcallOutputs<abi, name>> };

  // functions (api.md §8)
  fn<const params extends readonly ArgSpec[], const r extends FnReturn>(
    name: string,
    params: params,
    body: (...args: { [i in keyof params]: Expr<params[i]['type']> }) => r,
  ): EvsFn<params, r>;

  // return (api.md §9)
  return<const ret extends Record<string, Expr>>(values: ret): ScriptReturn<ret>;
}

// ---------------------------------------------------------------------------
// the facade (typed surface over the untyped Recorder engine)
// ---------------------------------------------------------------------------

function makeBuilder<args extends readonly ArgSpec[]>(r: Recorder): ScriptBuilder<args> {
  const builder = {
    args: r.argRecord(),

    lit: (type: unknown, value: unknown) => r.lit(type, value),
    let: (a: unknown, b?: unknown) => r.letCell(a, b),
    newArray: (elem: unknown, length: unknown) => r.newArray(elem, length),
    env: (kind: unknown) => r.env(kind),

    add: (a: unknown, b: unknown) => r.bin('add', a, b, 's.add()'),
    sub: (a: unknown, b: unknown) => r.bin('sub', a, b, 's.sub()'),
    mul: (a: unknown, b: unknown) => r.bin('mul', a, b, 's.mul()'),
    div: (a: unknown, b: unknown) => r.bin('div', a, b, 's.div()'),
    mod: (a: unknown, b: unknown) => r.bin('mod', a, b, 's.mod()'),
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

    if: (cond: unknown, then: unknown, otherwise?: unknown) => {
      r.ifStmt(cond, then, otherwise);
    },
    while: (cond: unknown, body: unknown) => {
      r.whileStmt(cond, body);
    },
    for: (range: unknown, body: unknown) => {
      r.forStmt(range, body);
    },
    select: (cond: unknown, a: unknown, b: unknown) => r.select(cond, a, b),

    call: (p: unknown) => r.subcall(p, 'strict').value,
    tryCall: (p: unknown) => {
      const res = r.subcall(p, 'try');
      return Object.freeze({ success: res.success, value: res.value });
    },

    fn: (name: unknown, params: unknown, body: unknown) => r.defineFn(name, params, body),

    return: (values: unknown) => r.ret(values),
  };
  // the facade implements the frozen api.md §4 surface; types are enforced at the surface,
  // the engine is dynamic
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return builder as unknown as ScriptBuilder<args>;
}
