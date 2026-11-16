/**
 * Type-level assertions that need no test runner. The type checker is the runner, so the same
 * files are checked by every checker in `scripts/matrix.ts`. Nothing here ever executes.
 */

type IsAny<t> = 0 extends 1 & t ? true : false;

/** `true` when `a` and `b` are assignable to each other and neither is `any`. */
export type Same<a, b> =
  IsAny<a> extends true
    ? false
    : IsAny<b> extends true
      ? false
      : [a] extends [b]
        ? [b] extends [a]
          ? true
          : false
        : false;

/** Compiles only when `t` is `true`: `expectType<Same<typeof x, Expr<'uint256'>>>()`. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type argument is the assertion
export declare function expectType<t extends true>(...proof: t extends true ? [] : [never]): void;
