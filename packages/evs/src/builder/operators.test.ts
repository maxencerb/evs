/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the recording legs deliberately defeat the type surface (`as never`) to show that what the
 * types refuse is what recording refuses. */
/**
 * The two-operand operators on `s`, `s.select`, `s.let(type, init)` and the typed `s.for`: every
 * call recording refuses for its operand types is refused by the types first, on the operand
 * that is wrong and in words that name both types. tsc runs on a source text here, because the
 * text and the position of the error are what a user gets (`operators.test-d.ts` holds the type
 * tests proper).
 */

import { describe, expect, test } from 'vite-plus/test';

import { tscDiagnostics } from '../../test/harness/tsc-errors.js';
import { EvsTypeError } from '../core/errors.js';
import { t } from '../core/types.js';
import { evscript, type ScriptBuilder } from './script.js';

/** One call per line, each refused at recording: the call text, and what recording throws. */
const REFUSED: readonly (readonly [call: string, recording: RegExp])[] = [
  // two Exprs of different types
  ['s.add(u256, u8)', /s\.add\(\): operand types differ \(Expr<'uint256'> vs Expr<'uint8'>\)/],
  ['s.lt(u256, addr)', /s\.lt\(\): operand types differ \(Expr<'uint256'> vs Expr<'address'>\)/],
  ['s.eq(u256, str)', /s\.eq\(\): operand types differ \(Expr<'uint256'> vs Expr<'string'>\)/],
  ['s.bitAnd(u256, u8)', /s\.bitAnd\(\): operand types differ/],
  ['s.select(flag, u256, u8)', /s\.select\(\): branch types differ/],
  ['s.let(t.int8, u256)', /s\.let\(\) init: expected 'int8', got Expr<'uint256'>/],
  ['s.let(t.address, u256)', /s\.let\(\) init: expected 'address', got Expr<'uint256'>/],
  [
    's.for({ type: t.uint8, from: 0, until: u256 }, () => {})',
    /range\.until: expected 'uint8', got Expr<'uint256'>/,
  ],
  // handles that are not values
  ['s.eq(cell, 1n)', /a Cell is not an Expr/],
  ['s.eq(tup.a, 1n)', /a Field is not an Expr/],
  ['s.select(flag, tup.a, tup.a)', /a Field is not an Expr/],
  // two literals: nothing gives the operation a type
  ['s.add(1n, 2n)', /s\.add\(\): at least one operand must be an Expr/],
  ['s.and(true, false)', /s\.and\(\): at least one operand must be an Expr/],
  ["s.select(flag, 'a', 'b')", /s\.select\(\): at least one branch must be an Expr/],
  ['s.select(flag, 1n, 2n)', /s\.select\(\): at least one branch must be an Expr/],
];

const HEADER = `
  import { evscript, t } from './index.js';
  const S = t.struct({ a: t.uint256, b: t.address });
  evscript(
    { name: 'p', args: [t.uint256, t.uint8, t.address, t.string, t.bool, S] },
    (s, u256, u8, addr, str, flag, tup) => {
      const cell = s.let(t.uint256, 1n);
`;
const FOOTER = `
      return s.return({ ok: flag });
    },
  );
`;
const HEADER_LINES = HEADER.split('\n').length - 1;

describe('what recording refuses for its operand types is a type error', () => {
  const source = `${HEADER}${REFUSED.map(([call]) => `${call};`).join('\n')}${FOOTER}`;
  // one checker run for the file: creating the program is the cost
  let cached: ReturnType<typeof tscDiagnostics> | undefined;
  const diagnostics = () => (cached ??= tscDiagnostics(source));
  const errorsOf = (call: string) => {
    const line = HEADER_LINES + 1 + REFUSED.findIndex(([c]) => c === call);
    return diagnostics().filter((d) => d.line === line);
  };

  test('every refused call is one error, and nothing else is', () => {
    expect(diagnostics().map((d) => d.line)).toEqual(
      REFUSED.map((_, index) => HEADER_LINES + 1 + index),
    );
  }, 60_000);

  test('each of those calls throws TYPE_MISMATCH when recorded', () => {
    const S = t.struct({ a: t.uint256, b: t.address });
    for (const [call, message] of REFUSED) {
      // the call text is run as written, over handles of the declared types
      // oxlint-disable-next-line typescript/no-implied-eval -- the text tsc checked above is the one recorded here
      const run = new Function('s', 't', 'u256', 'u8', 'addr', 'str', 'flag', 'tup', 'cell', call);
      let caught: unknown;
      try {
        evscript(
          { name: 'p', args: [t.uint256, t.uint8, t.address, t.string, t.bool, S] },
          (s, u256, u8, addr, str, flag, tup) => {
            run(s, t, u256, u8, addr, str, flag, tup, s.let(t.uint256, 1n));
            return s.return({ ok: flag });
          },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught, `${call}: throws`).toBeInstanceOf(EvsTypeError);
      expect((caught as EvsTypeError).code, `${call}: code`).toBe('TYPE_MISMATCH');
      expect((caught as EvsTypeError).message, `${call}: message`).toMatch(message);
    }
  });

  test('two Exprs of different types: the error is on the second operand and names both types', () => {
    const [error, ...rest] = errorsOf('s.add(u256, u8)');
    expect(rest).toEqual([]);
    expect(error?.code).toBe(2345);
    // `s.add(u256, u8);` is not indented: the second operand starts at column 13
    expect(error?.column).toBe('s.add(u256, '.length + 1);
    expect(error?.message.split('\n')[0]).toBe(
      `Argument of type 'Expr<"uint8">' is not assignable to parameter of type 'IntoExpr<"uint256">'.`,
    );
    // the same words as the method form's
    const method = tscDiagnostics(
      `${HEADER}u256.add(u8);${FOOTER}`.replace('const cell = s.let(t.uint256, 1n);', ''),
    );
    expect(method.map((d) => d.message.split('\n')[0])).toEqual([error?.message.split('\n')[0]]);
  }, 60_000);

  test('the other mixed calls point at the operand that is checked', () => {
    const first = (call: string) => {
      const [error] = errorsOf(call);
      return { column: error?.column, message: error?.message.split('\n')[0] };
    };
    expect(first('s.lt(u256, addr)')).toEqual({
      column: 's.lt(u256, '.length + 1,
      message: `Argument of type 'Expr<"address">' is not assignable to parameter of type 'IntoExpr<"uint256">'.`,
    });
    expect(first('s.select(flag, u256, u8)')).toEqual({
      column: 's.select(flag, u256, '.length + 1,
      message: `Argument of type 'Expr<"uint8">' is not assignable to parameter of type 'IntoExpr<"uint256">'.`,
    });
    expect(first('s.let(t.int8, u256)')).toEqual({
      column: 's.let(t.int8, '.length + 1,
      message: `Argument of type 'Expr<"uint256">' is not assignable to parameter of type 'IntoExpr<"int8">'.`,
    });
    expect(first('s.eq(cell, 1n)').column).toBe('s.eq('.length + 1);
  });

  test("two literals: the error is the recorder's message", () => {
    const hintOf = (call: string) =>
      / parameter of type '"(.*)" \| Expr<never>'\.$/.exec(
        errorsOf(call)[0]?.message.split('\n')[0] ?? '',
      )?.[1];
    const recorded = (body: (s: ScriptBuilder) => unknown): string => {
      try {
        evscript({ name: 'p', args: [t.bool] }, (s, flag) => {
          body(s);
          return s.return({ ok: flag });
        });
      } catch (e) {
        return (e as EvsTypeError).message;
      }
      return '';
    };
    expect(`s.add(): ${hintOf('s.add(1n, 2n)')}`).toBe(
      recorded((s) => s.add(1n as never, 2n as never)),
    );
    expect(`s.and(): ${hintOf('s.and(true, false)')}`).toBe(
      recorded((s) => s.and(true as never, false as never)),
    );
    expect(`s.select(): ${hintOf('s.select(flag, 1n, 2n)')}`).toBe(
      recorded((s) => s.select(true, 1n as never, 2n as never)),
    );
  });
});
