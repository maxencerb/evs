/**
 * Record-time constant folding vs runtime semantics.
 *
 * The recorder folds an operation whose operands are all literals (`foldBin`, plus the `bitNot`,
 * `not` and `toUint` / `toInt` folds in `builder/expr/ops.ts`) and refuses a fold that would
 * certainly panic (`CERTAIN_PANIC`). This table checks every folded result against the unfolded
 * form of the same operation, recorded over script args and run by `interpret()` (the reference
 * oracle the differential suite holds the bytecode to): op × {uint8, uint256, int8, int256,
 * bytes4, bytes32, bool} × edge operands must agree on the returned word, or on the Panic code.
 */

import { describe, expect, test } from 'vite-plus/test';

import { EvsError } from '../core/errors.js';
import type { Expr, WordType } from '../core/types.js';
import { interpret, type MockChain } from '../ir/interp.js';
import { walkStmts, type ScriptIr } from '../ir/nodes.js';
import { evscript, type ScriptBuilder } from './script.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the fold table records no sub-calls');
  },
};

const PANIC_SELECTOR = '0x4e487b71';

/** What one form of an operation produced: the ABI-encoded result, or a Panic code. */
type Outcome = { value: string } | { panic: number };

const MAX_UINT256 = 2n ** 256n - 1n;
const MIN_INT256 = -(2n ** 255n);
const MAX_INT256 = 2n ** 255n - 1n;

/** Shift amounts and pow exponents (both `uint256`), around every width boundary. */
const AMOUNTS: readonly bigint[] = [
  0n,
  1n,
  2n,
  3n,
  7n,
  8n,
  31n,
  32n,
  255n,
  256n,
  257n,
  MAX_UINT256,
];

const ARITH = ['add', 'sub', 'mul', 'div', 'mod', 'pow'] as const;
const CMP = ['lt', 'gt', 'lte', 'gte', 'eq', 'neq'] as const;
const BITS = ['bitAnd', 'bitOr', 'bitXor', 'shl', 'shr'] as const;
/** The ops whose right operand is a `uint256` amount rather than a value of the operand type. */
const AMOUNT_OPS: ReadonlySet<string> = new Set(['pow', 'shl', 'shr']);

interface Row {
  readonly type: WordType;
  /** Edge operands: range ends, their neighbours, zero, one, the sign bit. */
  readonly operands: readonly unknown[];
  /** The binary ops the engine accepts on the type (intN bitwise ops and shifts are outside the
   *  typed surface but implemented, so they fold too). */
  readonly binOps: readonly string[];
  readonly unary: readonly (readonly [method: string, target?: WordType])[];
}

const CONVERSIONS = [
  ['bitNot'],
  ['toUint', 'uint8'],
  ['toUint', 'uint256'],
  ['toInt', 'int8'],
  ['toInt', 'int256'],
] as const;

const ROWS: readonly Row[] = [
  {
    type: 'uint8',
    operands: [0n, 1n, 2n, 15n, 127n, 128n, 254n, 255n],
    binOps: [...ARITH, ...CMP, ...BITS],
    unary: CONVERSIONS,
  },
  {
    type: 'uint256',
    operands: [0n, 1n, 2n, 2n ** 128n, 2n ** 255n, MAX_UINT256 - 1n, MAX_UINT256],
    binOps: [...ARITH, ...CMP, ...BITS],
    unary: CONVERSIONS,
  },
  {
    type: 'int8',
    operands: [-128n, -127n, -2n, -1n, 0n, 1n, 2n, 127n],
    binOps: [...ARITH, ...CMP, ...BITS],
    unary: CONVERSIONS,
  },
  {
    type: 'int256',
    operands: [MIN_INT256, MIN_INT256 + 1n, -2n, -1n, 0n, 1n, 2n, MAX_INT256],
    binOps: [...ARITH, ...CMP, ...BITS],
    unary: CONVERSIONS,
  },
  {
    type: 'bytes4',
    operands: ['0x00000000', '0x00000001', '0x0000ff00', '0x80000000', '0xfffffffe', '0xffffffff'],
    binOps: ['eq', 'neq', ...BITS],
    unary: [['bitNot']],
  },
  {
    type: 'bytes32',
    operands: [
      `0x${'00'.repeat(32)}`,
      `0x${'00'.repeat(31)}01`,
      `0x80${'00'.repeat(31)}`,
      `0x${'12'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
    ],
    binOps: ['eq', 'neq', ...BITS],
    unary: [['bitNot']],
  },
  { type: 'bool', operands: [false, true], binOps: ['and', 'or', 'eq', 'neq'], unary: [['not']] },
];

/** Calls an Expr method by name, bypassing the typed surface (which narrows some ops by type). */
function callOp(x: unknown, method: string, ...args: unknown[]): Expr {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberate type-surface bypass
  const fn = (x as Record<string, (...a: unknown[]) => Expr>)[method];
  if (fn === undefined) throw new Error(`Expr has no method ${method}`);
  return fn.apply(x, args);
}

/** `s.lit(type, value)` for a table operand (the typed surface wants a per-type value). */
function lit(s: ScriptBuilder, type: WordType, value: unknown): Expr {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberate type-surface bypass
  return s.lit(type, value as never);
}

function run(ir: ScriptIr, args: readonly unknown[]): Outcome {
  const { outcome } = interpret(ir, args, NO_CHAIN);
  if (outcome.kind === 'return') return { value: outcome.data };
  if (!outcome.data.startsWith(PANIC_SELECTOR)) {
    throw new Error(`unexpected non-Panic revert ${outcome.data}`);
  }
  return { panic: Number(BigInt(`0x${outcome.data.slice(10)}`)) };
}

/** The folded form: `body(s)` over literals only. It must either record consts alone (and
 *  interpret to the same result) or be refused as a CERTAIN_PANIC naming the Panic code. */
function folded(body: (s: ScriptBuilder) => Expr): Outcome {
  let ir: ScriptIr;
  try {
    ir = evscript({ name: 'folded', args: [] }, (s) => s.return({ r: body(s) })).ir;
  } catch (e) {
    if (!(e instanceof EvsError) || e.code !== 'CERTAIN_PANIC') throw e;
    const code = /Panic\(0x([0-9a-f]+)\)/.exec(e.message)?.[1];
    if (code === undefined) throw new Error(`CERTAIN_PANIC without a Panic code`, { cause: e });
    return { panic: Number.parseInt(code, 16) };
  }
  walkStmts(ir.body, (st) => {
    if (st.k !== 'const') throw new Error(`the all-literal form recorded a '${st.k}' statement`);
  });
  return run(ir, []);
}

/** Runs `unfolded` over every operand tuple and returns the cases where the folded form differs. */
function mismatches(
  unfolded: ScriptIr,
  cases: readonly (readonly unknown[])[],
  foldedOf: (operands: readonly unknown[]) => (s: ScriptBuilder) => Expr,
): string[] {
  const out: string[] = [];
  const show = (v: unknown): string => (typeof v === 'bigint' ? `${v}n` : String(v));
  for (const operands of cases) {
    const want = run(unfolded, operands);
    const got = folded(foldedOf(operands));
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      out.push(
        `(${operands.map(show).join(', ')}): folded ${JSON.stringify(got)}, runtime ${JSON.stringify(want)}`,
      );
    }
  }
  return out;
}

describe('constant folding agrees with interpret() on the unfolded op', () => {
  for (const { type, operands, binOps, unary } of ROWS) {
    for (const op of binOps) {
      test(`${type}.${op}`, () => {
        const rhsType: WordType = AMOUNT_OPS.has(op) ? 'uint256' : type;
        const rhsOperands = AMOUNT_OPS.has(op) ? AMOUNTS : operands;
        const unfolded = evscript({ name: 'unfolded', args: [type, rhsType] }, (s, a, b) =>
          s.return({ r: callOp(a, op, b) }),
        ).ir;
        const cases = operands.flatMap((a) => rhsOperands.map((b) => [a, b] as const));
        expect(
          mismatches(
            unfolded,
            cases,
            ([a, b]) =>
              (s) =>
                callOp(lit(s, type, a), op, b),
          ),
        ).toEqual([]);
      });
    }
    for (const [method, target] of unary) {
      const extra = target === undefined ? [] : [target];
      test(`${type}.${method}(${target ?? ''})`, () => {
        const unfolded = evscript({ name: 'unfolded', args: [type] }, (s, a) =>
          s.return({ r: callOp(a, method, ...extra) }),
        ).ir;
        const cases = operands.map((a) => [a] as const);
        expect(
          mismatches(
            unfolded,
            cases,
            ([a]) =>
              (s) =>
                callOp(lit(s, type, a), method, ...extra),
          ),
        ).toEqual([]);
      });
    }
  }
});
