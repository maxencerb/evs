/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests deliberately defeat the type surface (`as never`) to prove the RUNTIME checks
 * catch the same misuses; every assertion below is a seeded violation. */
/* oxlint-disable vitest/expect-expect --
 * most tests assert through the expectEvs() helper (class + code + message); the rule only
 * recognizes direct expect* calls. */
/**
 * Input the recorder must refuse instead of recording it as something else: a callback that is
 * not synchronous, a struct literal without all its members, an array literal with a hole, an
 * `s.for` range with a key it does not have or a step that never advances, arguments `s.throw`
 * would drop, an operand that is no value, and a loop control reached around its scope check.
 */
import { parseAbi, type Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { compile } from '../compile.js';
import { EvsError, EvsScopeError, EvsTypeError, type EvsErrorCode } from '../core/errors.js';
import { namedArg, t, type Expr } from '../core/types.js';
import { interpret } from '../ir/interp.js';
import { evscript, type LoopCtl, type ScriptBuilder } from './script.js';

// digits only: its EIP-55 checksum form is itself
const ALICE = '0x0000000000000000000000000000000000000011';
const NO_CALLS = { staticcall: () => ({ success: false, data: '0x' as const }) };

function catchEvs(fn: () => unknown): EvsError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown instanceof EvsError) return thrown;
  throw new Error(`expected an EvsError to be thrown, got ${String(thrown)}`, { cause: thrown });
}

/** class + code + message, in one assertion helper. */
function expectEvs(
  fn: () => unknown,
  cls: abstract new (...a: never[]) => EvsError,
  code: EvsErrorCode,
  msg: string | RegExp,
): EvsError {
  const e = catchEvs(fn);
  expect(e).toBeInstanceOf(cls);
  expect(e.code).toBe(code);
  expect(e.message).toMatch(msg);
  return e;
}

/** A macrotask later: every promise job queued so far has run. */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// callbacks are synchronous
// ---------------------------------------------------------------------------

describe('callbacks run once, synchronously', () => {
  /** A script over `(uint256 x, bool flag, uint256[] xs)` whose body is `body`. */
  function rec(
    body: (
      s: ScriptBuilder,
      x: Expr<'uint256'>,
      flag: Expr<'bool'>,
      xs: Expr<'uint256[]'>,
    ) => unknown,
  ): unknown {
    return evscript(
      { name: 'sync', args: [t.uint256, t.bool, t.array(t.uint256)] },
      (s: ScriptBuilder, x: Expr<'uint256'>, flag: Expr<'bool'>, xs: Expr<'uint256[]'>) => {
        body(s, x, flag, xs);
        return s.return({ x });
      },
    );
  }

  /** Every callback the builder runs, each handed the function `make` builds. */
  const callbacks: readonly (readonly [
    string,
    (make: (record: () => void) => unknown) => unknown,
  ])[] = [
    [
      's.if() then branch',
      (make) =>
        rec((s, x, flag) => {
          const c = s.let(t.uint256, 0n);
          s.if(flag, make(() => c.set(x)) as never);
        }),
    ],
    [
      's.if() else branch',
      (make) =>
        rec((s, x, flag) => {
          const c = s.let(t.uint256, 0n);
          s.if(flag, () => c.set(1n), make(() => c.set(x)) as never);
        }),
    ],
    [
      's.while() condition',
      (make) =>
        rec((s, _x, flag) => {
          s.while(make(() => flag.type) as never, (loop) => loop.break());
        }),
    ],
    [
      's.while() body',
      (make) =>
        rec((s, x) => {
          const i = s.let(t.uint256, 0n);
          s.while(() => i.get().lt(x), make(() => i.set(i.get().add(1n))) as never);
        }),
    ],
    [
      's.for() body',
      (make) =>
        rec((s, x) => {
          const sum = s.let(t.uint256, 0n);
          s.for({ from: 0n, until: x }, make(() => sum.set(sum.get().add(1n))) as never);
        }),
    ],
    [
      's.forEach() body',
      (make) =>
        rec((s, _x, _flag, xs) => {
          const sum = s.let(t.uint256, 0n);
          s.forEach(xs, make(() => sum.set(sum.get().add(1n))) as never);
        }),
    ],
    [
      's.fn("inc") body',
      (make) =>
        rec((s, x) => {
          const c = s.let(t.uint256, 0n);
          s.fn('inc', [], make(() => undefined) as never);
          c.set(x);
        }),
    ],
    [
      'evscript "sync" body',
      (make) => evscript({ name: 'sync', args: [t.uint256] }, make(() => undefined) as never),
    ],
  ];

  test.each(callbacks)('%s: an async callback is refused, naming it', async (name, run) => {
    const late: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      late.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      expectEvs(
        () =>
          run((record) => async () => {
            await Promise.resolve();
            // after the await: the block (or the script) is closed, so this cannot be recorded
            record();
            throw new Error('the continuation of an async callback ran');
          }),
        EvsTypeError,
        'TYPE_MISMATCH',
        `${name}: the callback returned a Promise (an async function) — callbacks run once, synchronously`,
      );
      // the rejected promise of the callback must not surface as an unhandled rejection
      await settled();
      expect(late).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test.each(callbacks)('%s: a generator callback is refused, naming it', (name, run) => {
    expectEvs(
      () =>
        run(
          (record) =>
            function* () {
              record();
              yield 1;
            },
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      `${name}: the callback returned an iterator (a generator function)`,
    );
  });

  test('an async branch that records before its await is refused too (nothing is half-kept)', () => {
    let script: unknown;
    const e = catchEvs(() => {
      script = evscript({ name: 'half', args: [t.bool] }, (s, flag) => {
        const c = s.let(t.uint256, 0n);
        // oxlint-disable-next-line typescript/no-misused-promises -- the async branch is the seeded mistake
        s.if(flag, async () => {
          c.set(1n);
          await Promise.resolve();
          c.set(2n);
        });
        return s.return({ c: c.get() });
      });
    });
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toMatch(/^s\.if\(\) then branch: the callback returned a Promise/);
    expect(script).toBeUndefined();
  });

  test('a thenable that is no promise is refused without calling its then', () => {
    let called = false;
    const lazy = {
      // oxlint-disable-next-line unicorn/no-thenable -- a lazy thenable is the input under test
      then(): void {
        called = true;
      },
    };
    expectEvs(
      () =>
        evscript({ name: 'lazy', args: [t.bool] }, (s, flag) => {
          s.if(flag, () => lazy);
          return s.return({ flag });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.if() then branch: the callback returned a Promise',
    );
    expect(called).toBe(false);
  });

  test('a synchronous callback may return any value, a handle with a `next` member included', () => {
    const Node = t.struct({ value: t.uint256, next: t.uint256 });
    const script = evscript({ name: 'ok', args: [t.bool, Node] }, (s, flag, node) => {
      const c = s.let(t.uint256, 0n);
      s.if(
        flag,
        () => c.get(),
        () => 42,
      );
      const same = s.fn('same', Node, (n) => n);
      return s.return({ next: same(node).next.get(), c: c.get() });
    });
    const run = interpret(script, [true, { value: 1n, next: 7n }], NO_CALLS);
    expect(run.outcome).toMatchObject({ kind: 'return', values: { next: 7n, c: 0n } });
  });
});

// ---------------------------------------------------------------------------
// struct literals name every member
// ---------------------------------------------------------------------------

describe('a struct literal names every member', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  const Outer = t.struct({ id: t.uint256, inner: Pair });
  const PairErr = t.error('PairErr', [namedArg('p', Pair)]);
  const PAIR = { name: 'p', type: 'tuple', components: Pair.components } as const;
  const pairAbi = [
    {
      type: 'function',
      name: 'take',
      stateMutability: 'view',
      inputs: [PAIR],
      outputs: [{ name: '', type: 'bool' }],
    },
    {
      type: 'function',
      name: 'takeMany',
      stateMutability: 'view',
      inputs: [{ ...PAIR, type: 'tuple[]' }],
      outputs: [{ name: '', type: 'bool' }],
    },
  ] as const satisfies Abi;

  function recT(body: (s: ScriptBuilder, who: Expr<'address'>) => unknown): void {
    evscript(
      { name: 'structs', args: [t.address], errors: [PairErr] },
      (s: ScriptBuilder, who: Expr<'address'>) => {
        body(s, who);
        return s.return({ who });
      },
    );
  }

  /** Every position that coerces a literal to the `Pair` struct, and how its error names it. */
  const slots: readonly (readonly [
    string,
    string,
    (s: ScriptBuilder, who: Expr<'address'>, value: unknown) => unknown,
  ])[] = [
    ['s.lit', 's.lit()', (s, _who, v) => s.lit(Pair, v as never)],
    ['s.let', 's.let() init', (s, _who, v) => s.let(Pair, v as never)],
    [
      'Cell.set',
      'Cell.set()',
      (s, who, v) => s.let(Pair, { token: who, fee: 1 } as never).set(v as never),
    ],
    ['Field.set', 'Field.set()', (s, _who, v) => s.tuple(Outer).inner.set(v as never)],
    [
      'MutArray.set',
      'MutArray.set() value',
      (s, _who, v) => s.newArray(Pair, 1n).set(0n, v as never),
    ],
    [
      'call argument',
      's.read() args[0] ("p")',
      (s, who, v) =>
        s.read({ address: who, abi: pairAbi, functionName: 'take', args: [v as never] }),
    ],
    [
      'array element',
      's.read() args[0] ("p")[1]',
      (s, who, v) =>
        s.read({
          address: who,
          abi: pairAbi,
          functionName: 'takeMany',
          args: [[{ token: who, fee: 1 }, v] as never],
        }),
    ],
    [
      'nested member',
      's.lit() member "inner"',
      (s, _who, v) => s.lit(Outer, { id: 1n, inner: v } as never),
    ],
    [
      'nested member of an s.tuple init',
      's.tuple() member "inner"',
      (s, _who, v) => s.tuple(Outer, { inner: v } as never),
    ],
    ['s.fn argument', 'fn "feeOf" arg 0 ("arg0")', (s, _who, v) => feeOf(s)(v as never)],
    ['s.throw argument', 's.throw() arg "p"', (s, _who, v) => s.throw(PairErr, { p: v } as never)],
    [
      // a literal has a struct type to be coerced to only next to a handle of that type
      's.select branch',
      's.select() branch',
      (s, who, v) => s.select(true, s.tuple(Pair, { token: who }).expr(), v as never),
    ],
    [
      's.return, through s.lit',
      's.lit()',
      (s, _who, v) => s.return({ p: s.lit(Pair, v as never) }),
    ],
  ];

  function feeOf(s: ScriptBuilder) {
    return s.fn('feeOf', Pair, (p) => p.fee.get());
  }

  test.each(slots)('%s: a member left out is refused, naming it', (_name, what, slot) => {
    const e = expectEvs(
      () => recT((s, who) => slot(s, who, { token: who })),
      EvsTypeError,
      'TYPE_MISMATCH',
      'the struct literal has no value for member "fee" (left out or undefined; members: token, fee). A struct literal names every member; to leave members at zero, build the struct with s.tuple(type, init)',
    );
    expect(e.message.startsWith(`${what}: `)).toBe(true);
  });

  test.each(slots)('%s: an undefined member is refused, naming it', (_name, what, slot) => {
    const config: { token?: string } = {};
    const e = expectEvs(
      () => recT((s, who) => slot(s, who, { token: config.token, fee: 500 })),
      EvsTypeError,
      'TYPE_MISMATCH',
      'the struct literal has no value for member "token" (left out or undefined',
    );
    expect(e.message.startsWith(`${what}: `)).toBe(true);
  });

  test.each(slots)('%s: an empty object is refused, naming every member', (_name, what, slot) => {
    const e = expectEvs(
      () => recT((s, who) => slot(s, who, {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      'the struct literal has no value for members "token", "fee"',
    );
    expect(e.message.startsWith(`${what}: `)).toBe(true);
  });

  test.each(slots)('%s: an object without own members is refused', (_name, _what, slot) => {
    class PairLike {
      get token(): string {
        return ALICE;
      }
      get fee(): number {
        return 500;
      }
    }
    for (const value of [new Map<string, unknown>([['token', ALICE]]), new PairLike()]) {
      expectEvs(
        () => recT((s, who) => slot(s, who, value)),
        EvsTypeError,
        'TYPE_MISMATCH',
        'the struct literal has no value for members "token", "fee"',
      );
    }
  });

  test.each(slots)('%s: null is refused', (_name, what, slot) => {
    expectEvs(
      () => recT((s, who) => slot(s, who, null)),
      EvsTypeError,
      'TYPE_MISMATCH',
      `${what}: expected a struct value — a record { token, fee } or a Tuple handle — got null. A struct literal names every member; to leave members at zero, build the struct with s.tuple(type, init)`,
    );
  });

  // an `undefined` in these positions is refused by the value around it, with an error of its
  // own: `s.let(type, undefined)` is the one-argument overload, an array element is refused as an
  // element, and a member is refused as a missing member of the literal that holds it
  const undefinedRefusedAround: Readonly<Record<string, RegExp>> = {
    's.let': /^s\.let\(type, init\): init value is required$/,
    'array element': /^s\.read\(\) args\[0\] \("p"\)\[1\]: the element is undefined/,
    'nested member': /^s\.lit\(\): the struct literal has no value for member "inner"/,
  };
  // the one place where a member may be left out: the top level of an s.tuple init
  const PARTIAL_SLOT = 'nested member of an s.tuple init';

  test.each(slots.filter(([name]) => name !== PARTIAL_SLOT))(
    '%s: undefined is refused',
    (name, what, slot) => {
      expectEvs(
        () => recT((s, who) => slot(s, who, undefined)),
        EvsTypeError,
        'TYPE_MISMATCH',
        undefinedRefusedAround[name] ??
          `${what}: expected a struct value — a record { token, fee } or a Tuple handle — got undefined. A struct literal names every member; to leave members at zero, build the struct with s.tuple(type, init)`,
      );
    },
  );

  test('an undefined member of an s.tuple init is a member left out', () => {
    const slot = slots.find(([name]) => name === PARTIAL_SLOT)?.[2];
    expect(slot).toBeDefined();
    expect(() => recT((s, who) => slot?.(s, who, undefined))).not.toThrow();
  });

  test.each(slots)(
    '%s: a misspelled member is refused with the closest name',
    (_name, what, slot) => {
      const e = expectEvs(
        () => recT((s, who) => slot(s, who, { tokn: who, fee: 500 })),
        EvsTypeError,
        'TYPE_MISMATCH',
        'unknown member "tokn" — did you mean "token"? (expected: token, fee)',
      );
      expect(e.message.startsWith(`${what}: `)).toBe(true);
    },
  );

  test('an unknown member that resembles none is refused without a suggestion', () => {
    expectEvs(
      () => recT((s, who) => s.lit(Pair, { token: who, fee: 500, recipient: who } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.lit(): unknown member "recipient" (expected: token, fee)',
    );
  });

  test('a positional tuple literal has one value per member', () => {
    const Range = t.tuple(t.int24, t.address);
    const sparse: unknown[] = [];
    sparse[1] = ALICE;
    for (const [value, missing] of [
      [[60], '"[1]"'],
      [[60, undefined], '"[1]"'],
      [sparse, '"[0]"'],
      [[], 'members "[0]", "[1]"'],
    ] as const) {
      expectEvs(
        () => recT((s) => s.lit(Range, value as never)),
        EvsTypeError,
        'TYPE_MISMATCH',
        new RegExp(
          `^s\\.lit\\(\\): the struct literal has no value for (member )?${missing.replaceAll('[', '\\[')} \\(left out or undefined; members: \\[0\\], \\[1\\]\\)`,
        ),
      );
    }
    expectEvs(
      () => recT((s) => s.lit(Range, undefined as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.lit(): expected a struct value — a positional array of its 2 member(s) or a Tuple handle — got undefined',
    );
  });

  test('nothing of a refused literal is recorded', () => {
    const script = evscript({ name: 'clean', args: [t.address] }, (s, who) => {
      expect(() => s.lit(Pair, { token: who } as never)).toThrow(/no value for member "fee"/);
      return s.return({ who });
    });
    expect(script.ir.body).toEqual([]);
  });

  test('s.tuple init stays partial: absent, empty, short or undefined members are zero', () => {
    const Range = t.tuple(t.int24, t.address);
    const script = evscript({ name: 'partial', args: [t.address] }, (s, who) => {
      const config: { fee?: number } = {};
      return s.return({
        none: s.tuple(Pair),
        empty: s.tuple(Pair, {}),
        one: s.tuple(Pair, { token: who }),
        undef: s.tuple(Pair, { token: who, fee: config.fee } as never),
        outer: s.tuple(Outer, { inner: { token: who, fee: 500 } }),
        short: s.tuple(Range, [60]),
      });
    });
    const ZERO = '0x0000000000000000000000000000000000000000';
    expect(interpret(script, [ALICE], NO_CALLS).outcome).toMatchObject({
      kind: 'return',
      values: {
        none: { token: ZERO, fee: 0 },
        empty: { token: ZERO, fee: 0 },
        one: { token: ALICE, fee: 0 },
        undef: { token: ALICE, fee: 0 },
        outer: { id: 0n, inner: { token: ALICE, fee: 500 } },
        short: [60, ZERO],
      },
    });
  });

  test('a complete literal and a handle record as before', () => {
    const script = evscript({ name: 'complete', args: [t.address] }, (s, who) => {
      const handle = s.tuple(Pair, { token: who, fee: 3000 });
      // the types of s.lit, s.let and Cell.set take plain literals only; the recorder takes more
      const lit = s.lit(Outer, { id: 7n, inner: handle } as never);
      const cell = s.let(Pair, { token: who, fee: 0 } as never);
      cell.set(handle as never);
      return s.return({ lit, cell: cell.get() });
    });
    expect(interpret(script, [ALICE], NO_CALLS).outcome).toMatchObject({
      kind: 'return',
      values: {
        lit: { id: 7n, inner: { token: ALICE, fee: 3000 } },
        cell: { token: ALICE, fee: 3000 },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// array literals give every element a value
// ---------------------------------------------------------------------------

describe('an array literal gives every element a value', () => {
  const Point = t.struct({ a: t.uint256, b: t.bool });
  const arrAbi = parseAbi([
    'function sum(uint256[] xs) view returns (uint256)',
    'function names(string[] xs) view returns (uint256)',
  ]);

  /** `[first, <hole>, last]`: index 1 is never assigned. */
  function sparse(first: unknown, last: unknown): unknown[] {
    const xs: unknown[] = [];
    xs[0] = first;
    xs[2] = last;
    return xs;
  }

  function recA(
    body: (s: ScriptBuilder, x: Expr<'uint256'>, who: Expr<'address'>) => unknown,
  ): void {
    evscript(
      { name: 'arrays', args: [t.uint256, t.address] },
      (s: ScriptBuilder, x: Expr<'uint256'>, who: Expr<'address'>) => {
        body(s, x, who);
        return s.return({ x });
      },
    );
  }

  /** Every position that coerces a literal to `uint256[]`, fed `[first, <missing>, last]`. */
  const slots: readonly (readonly [
    string,
    (s: ScriptBuilder, who: Expr<'address'>, xs: unknown) => unknown,
  ])[] = [
    ['s.lit', (s, _who, xs) => s.lit(t.array(t.uint256), xs as never)],
    ['s.let', (s, _who, xs) => s.let(t.array(t.uint256), xs as never)],
    ['Cell.set', (s, _who, xs) => s.let(t.array(t.uint256), [1n]).set(xs as never)],
    [
      'Field.set',
      (s, _who, xs) => s.tuple(t.struct({ xs: t.array(t.uint256) })).xs.set(xs as never),
    ],
    ['MutArray.set', (s, _who, xs) => s.newArray(t.array(t.uint256), 1n).set(0n, xs as never)],
    [
      'call argument',
      (s, who, xs) =>
        s.read({ address: who, abi: arrAbi, functionName: 'sum', args: [xs as never] }),
    ],
    ['array element', (s, _who, xs) => s.lit(t.array(t.array(t.uint256)), [[1n], xs] as never)],
    [
      'struct member',
      (s, _who, xs) => s.lit(t.struct({ xs: t.array(t.uint256) }), { xs } as never),
    ],
    [
      's.fn argument',
      (s, _who, xs) => s.fn('len', t.array(t.uint256), (a) => a.length())(xs as never),
    ],
    [
      's.select branch',
      (s, _who, xs) => s.select(true, s.lit(t.array(t.uint256), [1n]), xs as never),
    ],
    ['memref equality', (s, _who, xs) => s.lit(t.array(t.uint256), [1n]).eq(xs as never)],
    [
      's.return, through s.lit',
      (s, _who, xs) => s.return({ r: s.lit(t.array(t.uint256), xs as never) }),
    ],
  ];

  test.each(slots)(
    '%s: a hole in a constant word array is refused, naming its index',
    (_name, slot) => {
      expectEvs(
        () => recA((s, _x, who) => slot(s, who, sparse(5n, 7n))),
        EvsTypeError,
        'TYPE_MISMATCH',
        '[1]: the element is a hole (the array is sparse) — an array literal gives every element a value',
      );
    },
  );

  test.each(slots)('%s: an undefined element is refused, naming its index', (_name, slot) => {
    expectEvs(
      () => recA((s, _x, who) => slot(s, who, [5n, undefined, 7n])),
      EvsTypeError,
      'TYPE_MISMATCH',
      '[1]: the element is undefined — an array literal gives every element a value',
    );
  });

  test.each(slots)(
    '%s: a hole next to an Expr element is refused, naming its index',
    (_name, slot) => {
      expectEvs(
        () => recA((s, x, who) => slot(s, who, sparse(x, 7n))),
        EvsTypeError,
        'TYPE_MISMATCH',
        '[1]: the element is a hole (the array is sparse)',
      );
    },
  );

  test('the builder call is named when the literal is built element by element', () => {
    expectEvs(
      () => recA((s, x) => s.lit(t.array(t.uint256), sparse(x, 7n) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /^s\.lit\(\)\[1\]: the element is a hole/,
    );
    expectEvs(
      () => recA((s) => s.lit(t.array(t.uint256), sparse(5n, 7n) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /^uint256\[\] literal\[1\]: the element is a hole/,
    );
  });

  test('string[], T[][], T[N] and struct[] literals refuse a hole too', () => {
    const cases: readonly (readonly [string, (s: ScriptBuilder) => unknown, RegExp])[] = [
      [
        'string[]',
        (s) => s.lit(t.array(t.string), sparse('a', 'c') as never),
        /^s\.lit\(\)\[1\]: /,
      ],
      [
        'string[] call argument',
        (s) =>
          s.read({
            address: ALICE,
            abi: arrAbi,
            functionName: 'names',
            args: [sparse('a', 'c') as never],
          }),
        /^s\.read\(\) args\[0\] \("xs"\)\[1\]: /,
      ],
      [
        'uint256[][]',
        (s) => s.lit(t.array(t.array(t.uint256)), sparse([1n], [2n]) as never),
        /^s\.lit\(\)\[1\]: /,
      ],
      [
        'uint256[3]',
        (s) => s.lit(t.array(t.uint256, 3), sparse(1n, 3n) as never),
        /^uint256\[3\] literal\[1\]: /,
      ],
      [
        'struct[]',
        (s) => s.lit(t.array(Point), Array.from({ length: 2 }) as never),
        /^s\.lit\(\)\[0\]: /,
      ],
      [
        'struct[] of holes',
        (s) => s.lit(t.array(Point), sparse({ a: 1n, b: true }, { a: 2n, b: false }) as never),
        /^s\.lit\(\)\[1\]: the element is a hole/,
      ],
    ];
    for (const [, build, where] of cases) {
      const e = expectEvs(() => recA((s) => build(s)), EvsTypeError, 'TYPE_MISMATCH', where);
      expect(e.message).toMatch(/the element is (a hole \(the array is sparse\)|undefined)/);
    }
  });

  test('nothing of a refused literal is recorded', () => {
    const script = evscript({ name: 'clean', args: [t.uint256] }, (s, x) => {
      expect(() => s.lit(t.array(t.uint256), sparse(x, 7n) as never)).toThrow(/is a hole/);
      return s.return({ x });
    });
    expect(script.ir.body).toEqual([]);
  });

  test('a dense literal records as before, zero and empty elements included', () => {
    const script = evscript({ name: 'dense', args: [t.uint256] }, (s, x) =>
      s.return({
        words: s.lit(t.array(t.uint256), [0n, 5n]),
        mixed: s.lit(t.array(t.uint256), [x, 0n]),
        names: s.lit(t.array(t.string), ['', 'b']),
        none: s.lit(t.array(t.uint256), []),
      }),
    );
    expect(interpret(script, [9n], NO_CALLS).outcome).toMatchObject({
      kind: 'return',
      values: { words: [0n, 5n], mixed: [9n, 0n], names: ['', 'b'], none: [] },
    });
  });
});

// ---------------------------------------------------------------------------
// s.for ranges
// ---------------------------------------------------------------------------

describe('s.for range', () => {
  /** Records `s.for(range, …)` counting its iterations, and returns the script. */
  function loop(range: unknown) {
    return evscript({ name: 'range', args: [t.uint256] }, (s, step) => {
      const n = s.let(t.uint256, 0n);
      const r =
        typeof range === 'function'
          ? (range as (s: unknown, step: unknown) => unknown)(s, step)
          : range;
      s.for(r as never, () => {
        n.set(n.get().add(1n));
      });
      return s.return({ n: n.get() });
    });
  }

  function iterations(range: unknown, step = 1n): unknown {
    const run = interpret(loop(range), [step], NO_CALLS, { maxSteps: 10_000 });
    return run.outcome.kind === 'return' ? run.outcome.values.n : run.outcome;
  }

  test('a misspelled key is refused with the key it resembles', () => {
    expectEvs(
      () => loop({ from: 0n, until: 6n, setp: 2n }),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.for(): unknown range key "setp" — did you mean "step"? (the range is { type?, from, until, step? })',
    );
    expectEvs(
      () => loop({ form: 0n, until: 6n }),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.for(): unknown range key "form" — did you mean "from"?',
    );
  });

  test('a key of another API is refused', () => {
    expectEvs(
      () => loop({ from: 0n, until: 6n, to: 3n }),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.for(): unknown range key "to" (the range is { type?, from, until, step? })',
    );
    expectEvs(() => loop([0n, 6n]), EvsTypeError, 'TYPE_MISMATCH', 's.for(): range must be');
  });

  test('step: null is refused, and an absent or undefined step is 1', () => {
    expectEvs(
      () => loop({ from: 0n, until: 6n, step: null }),
      EvsTypeError,
      'TYPE_MISMATCH',
      "s.for(): range.step must be an Expr or a literal of 'uint256', got null — leave it out for a step of 1",
    );
    expect(iterations({ from: 0n, until: 6n })).toBe(6n);
    expect(iterations({ from: 0n, until: 6n, step: undefined })).toBe(6n);
    expect(iterations({ from: 0n, until: 6n, step: 2n })).toBe(3n);
  });

  test.each([
    ['0n', 0n],
    ['0', 0],
    ['-0', -0],
    ['s.lit(t.uint256, 0n)', (s: ScriptBuilder) => s.lit(t.uint256, 0n)],
  ])('a literal step of %s is refused', (_label, step) => {
    const range =
      typeof step === 'function'
        ? (s: ScriptBuilder) => ({ from: 0n, until: 6n, step: step(s) })
        : { from: 0n, until: 6n, step };
    expectEvs(
      () => loop(range),
      EvsTypeError,
      'LITERAL_RANGE',
      's.for(): range.step is the literal 0 — the counter would never advance',
    );
  });

  test('a host zero step is refused before anything is recorded', () => {
    const script = evscript({ name: 'clean', args: [t.uint256] }, (s, x) => {
      expect(() => {
        s.for({ from: 0n, until: 6n, step: 0n }, () => undefined);
      }).toThrow(/is the literal 0/);
      return s.return({ x });
    });
    expect(script.ir.body).toEqual([]);
  });

  test('a step only known at run time is recorded as before', () => {
    const byArg = (s: unknown, step: unknown) => ({ from: 0n, until: 6n, step });
    expect(iterations(byArg, 3n)).toBe(2n);
    expect(() => iterations(byArg, 0n)).toThrow(/exceeded maxSteps/);
  });
});

// ---------------------------------------------------------------------------
// s.throw arguments
// ---------------------------------------------------------------------------

describe('s.throw takes its args as one value', () => {
  const Named = t.error('Named', [namedArg('amount', t.uint256)]);
  const Bare = t.error('Bare', [t.uint256]);
  const Empty = t.error('Empty', []);

  function recE(body: (s: ScriptBuilder) => unknown): void {
    evscript({ name: 'throws', errors: [Named, Bare, Empty] }, (s: ScriptBuilder) => {
      body(s);
      return s.return({ ok: s.lit(t.bool, true) });
    });
  }

  test('values after the args are refused, not dropped', () => {
    const throwAny = (s: ScriptBuilder, ...args: unknown[]): void => {
      (s.throw as (...a: unknown[]) => void)(...args);
    };
    expectEvs(
      () => recE((s) => throwAny(s, Named, { amount: 1n }, { amount: 2n }, 'junk')),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.throw(): error "Named" takes its args as one value (a record or a tuple), got 3 values after the error — the extra ones would be dropped',
    );
    expectEvs(
      () => recE((s) => throwAny(s, Bare, [1n], [2n])),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.throw(): error "Bare" takes its args as one value (a record or a tuple), got 2 values',
    );
    expectEvs(
      () => recE((s) => throwAny(s, Empty, undefined, 'junk')),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.throw(): error "Empty" takes no args, got 2 values after the error',
    );
  });

  test('a misspelled arg is refused with the closest name', () => {
    expectEvs(
      () => recE((s) => s.throw(Named, { amout: 1n } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      's.throw(): unknown arg "amout" for error "Named" — did you mean "amount"? (expected: amount)',
    );
  });

  test('one args value records as before, a trailing undefined included', () => {
    expect(() =>
      recE((s) => {
        s.throw(Named, { amount: 1n });
        s.throw(Bare, [1n]);
        s.throw(Empty);
        (s.throw as (...a: unknown[]) => void)(Named, { amount: 1n }, undefined);
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// operands that are no value
// ---------------------------------------------------------------------------

describe('an operand that is no value', () => {
  function recX(body: (s: ScriptBuilder, x: Expr<'uint256'>) => unknown): void {
    evscript({ name: 'operands', args: [t.uint256] }, (s: ScriptBuilder, x: Expr<'uint256'>) => {
      body(s, x);
      return s.return({ x });
    });
  }

  const noPrototype: unknown = Object.create(null);
  const throwing = {
    toString(): string {
      throw new Error('toString ran');
    },
  };

  test.each([
    ['a null-prototype object', noPrototype],
    ['an object whose toString throws', throwing],
    ['a Promise', Promise.resolve(1n)],
    ['a Map', new Map()],
  ])('%s as an operand is a coded error that does not stringify it', (_name, value) => {
    expectEvs(
      () => recX((_s, x) => x.add(value as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      'uint256 literal must be a number or bigint, got an object',
    );
  });

  test('every literal kind describes an object without calling its toString', () => {
    const cases: readonly (readonly [(s: ScriptBuilder) => unknown, string])[] = [
      [(s) => s.lit(t.bool, noPrototype as never), 'bool literal must be a boolean, got an object'],
      [
        (s) => s.lit(t.address, noPrototype as never),
        'address literal must be a 0x-prefixed hex string, got an object',
      ],
      [
        (s) => s.lit(t.bytes32, throwing as never),
        'bytes32 literal must be a 0x-prefixed hex string, got an object',
      ],
      [
        (s) => s.lit(t.string, noPrototype as never),
        'string literal must be a JS string, got an object',
      ],
      [
        (s) => s.lit(t.array(t.uint256), noPrototype as never),
        'uint256[] literal must be an array, got an object',
      ],
      [
        (s) => s.lit(t.uint256, (() => 1n) as never),
        'uint256 literal must be a number or bigint, got a function',
      ],
    ];
    for (const [build, message] of cases) {
      expectEvs(() => recX((s) => build(s)), EvsTypeError, 'TYPE_MISMATCH', message);
    }
  });

  test('a Proxy around a handle is named as the operand it is', () => {
    expectEvs(
      () => recX((_s, x) => x.eq(new Proxy(x, {}))),
      EvsTypeError,
      'TYPE_MISMATCH',
      '.eq() right operand: this object stands in for an evs handle without being one (a Proxy around a handle',
    );
    expectEvs(
      () => recX((s, x) => s.add(Object.create(x) as typeof x, 1n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      'this object stands in for an evs handle without being one',
    );
  });
});

// ---------------------------------------------------------------------------
// loop control internals
// ---------------------------------------------------------------------------

describe('a LoopCtl holds nothing but break and continue', () => {
  /** Records a script whose loops hand their control objects to `seen`. */
  function loops(seen: (kind: string, loop: LoopCtl) => void) {
    return evscript({ name: 'loops', args: [t.uint256, t.array(t.uint256)] }, (s, x, xs) => {
      s.while(
        () => s.lit(t.bool, false),
        (loop) => {
          seen('s.while', loop);
        },
      );
      s.for({ from: 0n, until: x }, (_i, loop) => {
        seen('s.for', loop);
      });
      s.forEach(xs, (_el, _i, loop) => {
        seen('s.forEach', loop);
      });
      return s.return({ x });
    });
  }

  test('no recorder, scope, guard or emit can be reached from it', () => {
    const kinds: string[] = [];
    loops((kind, loop) => {
      kinds.push(kind);
      expect(new Set(Reflect.ownKeys(loop))).toEqual(
        new Set(kind === 's.while' ? [] : ['break', 'continue']),
      );
      const members = new Set<PropertyKey>();
      for (let o: object | null = loop; o !== null && o !== Object.prototype;) {
        for (const key of Reflect.ownKeys(o)) members.add(key);
        o = Reflect.getPrototypeOf(o);
      }
      members.delete('constructor');
      expect(members).toEqual(new Set(['break', 'continue']));
      for (const hidden of ['owner', 'bodyScope', 'guard', 'emit']) {
        expect(hidden in loop).toBe(false);
      }
    });
    expect(kinds).toEqual(['s.while', 's.for', 's.forEach']);
  });

  test.each(['s.while', 's.for', 's.forEach'])(
    'a %s control used after its loop is refused at recording, and the script still compiles',
    (kind) => {
      for (const jump of ['break', 'continue'] as const) {
        let escaped: LoopCtl | undefined;
        const script = evscript(
          { name: 'late', args: [t.uint256, t.array(t.uint256)] },
          (s, x, xs) => {
            const keep = (loop: LoopCtl): void => {
              escaped = loop;
            };
            if (kind === 's.while') s.while(() => s.lit(t.bool, false), keep);
            if (kind === 's.for') s.for({ from: 0n, until: x }, (_i, loop) => keep(loop));
            if (kind === 's.forEach') s.forEach(xs, (_el, _i, loop) => keep(loop));
            expectEvs(
              () => escaped?.[jump](),
              EvsScopeError,
              'SCOPE_VIOLATION',
              `loop.${jump}(): LoopCtl used outside its owning loop's body`,
            );
            return s.return({ x });
          },
        );
        expect(() => compile(script)).not.toThrow();
      }
    },
  );

  test('continue in a counter loop still records the step first', () => {
    const script = evscript({ name: 'odd', args: [t.uint256] }, (s, n) => {
      const total = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i, loop) => {
        s.if(i.mod(2n).eq(0n), () => loop.continue());
        total.set(total.get().add(i));
      });
      return s.return({ total: total.get() });
    });
    expect(interpret(script, [6n], NO_CALLS).outcome).toMatchObject({
      kind: 'return',
      values: { total: 9n },
    });
  });
});
