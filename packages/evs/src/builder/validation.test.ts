/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests deliberately defeat the type surface (`as never`) to prove the RUNTIME checks
 * catch the same misuses; every assertion below is a seeded violation. */
/* oxlint-disable vitest/expect-expect --
 * every test asserts through the expectEvs()/catchEvs() helpers (class + code + message + loc);
 * the rule only recognizes direct expect* calls. */
/**
 * M5 unit tests — the recording-time validation checklist (module-interfaces §M5 invariant 5):
 * every item asserts the error class, the error code, a message substring, AND the loc
 * (pointing into this file). Plus staging traps, foreign/cross-scope handles, and LoopCtl
 * scoping.
 */
import { inspect } from 'node:util';

import type { Abi } from 'abitype';
import { describe, expect, test } from 'vitest';

import {
  EvsError,
  EvsScopeError,
  EvsStagingError,
  EvsTypeError,
  type EvsErrorCode,
} from '../core/errors.js';
import { arg, t, type Expr } from '../core/types.js';
import { evscript, type LoopCtl, type ScriptBuilder } from './script.js';

const erc20Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const overloadedAbi = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const tupleAbi = [
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'data',
        type: 'tuple',
        components: [{ name: 'a', type: 'uint256' }],
      },
    ],
  },
] as const satisfies Abi;

type AnyBuilder = ScriptBuilder<
  readonly [
    { readonly name: 'x'; readonly type: 'uint256' },
    { readonly name: 'who'; readonly type: 'address' },
    { readonly name: 'flag'; readonly type: 'bool' },
    { readonly name: 'xs'; readonly type: 'uint64[]' },
    { readonly name: 's8'; readonly type: 'int8' },
  ]
>;

/** Records a throwaway script whose body is expected to throw. */
function rec(body: (s: AnyBuilder) => unknown): void {
  evscript(
    {
      name: 'tst',
      args: [
        arg('x', t.uint256),
        arg('who', t.address),
        arg('flag', t.bool),
        arg('xs', t.array(t.uint64)),
        arg('s8', t.int8),
      ],
    },
    body as never,
  );
}

function catchEvs(fn: () => unknown): EvsError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EvsError);
    return e as EvsError;
  }
  throw new Error('expected an EvsError to be thrown');
}

/** class + code + message substring + loc-in-this-file, in one assertion helper. */
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
  expect(e.loc).not.toBeNull();
  expect(e.loc?.file).toMatch(/validation\.test\.ts/);
  expect(e.loc?.line).toBeGreaterThan(0);
  return e;
}

// ---------------------------------------------------------------------------
// arg declaration errors
// ---------------------------------------------------------------------------

describe('checklist: duplicate/empty/invalid arg names + types', () => {
  test('duplicate arg names', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: [arg('a', t.uint256), arg('a', t.address)] }, (s) =>
          s.return({ a: s.args.a }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /duplicate argument name "a"/,
    );
  });

  test('empty arg name (raw spec bypassing arg())', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: [{ name: '', type: 'uint256' }] as never }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /invalid argument name ""/,
    );
  });

  test('non-identifier arg name', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: [{ name: '1x', type: 'uint256' }] as never }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /invalid argument name "1x"/,
    );
  });

  test('unknown arg type (uint7)', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: [{ name: 'a', type: 'uint7' }] as never }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown ABI type "uint7"/,
    );
  });

  test('deferred arg type (tuple) → UNSUPPORTED_V0', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: [{ name: 'a', type: 'tuple' }] as never }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /not supported in evs v0/,
    );
  });

  test('invalid script name', () => {
    expectEvs(
      () =>
        evscript({ name: 'not a name' as never, args: [] }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /script name/,
    );
  });
});

// ---------------------------------------------------------------------------
// literal validation
// ---------------------------------------------------------------------------

describe('checklist: literal out of range / wrong hex length / unsafe number', () => {
  test('uint8 literal out of range', () => {
    expectEvs(() => rec((s) => s.lit(t.uint8, 256)), EvsTypeError, 'LITERAL_RANGE', /out of range/);
  });

  test('negative literal for an unsigned type', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, -1n)),
      EvsTypeError,
      'LITERAL_RANGE',
      /out of range/,
    );
  });

  test('unsafe JS number', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 2 ** 53)),
      EvsTypeError,
      'LITERAL_RANGE',
      /safe integer/,
    );
  });

  test('address literal with the wrong byte length', () => {
    expectEvs(
      () => rec((s) => s.lit(t.address, '0x1234')),
      EvsTypeError,
      'LITERAL_RANGE',
      /exactly 20 bytes/,
    );
  });

  test('bytes4 literal with the wrong byte length', () => {
    expectEvs(
      () => rec((s) => s.lit(t.bytes4, '0x1122')),
      EvsTypeError,
      'LITERAL_RANGE',
      /exactly 4 bytes/,
    );
  });

  test('odd-length hex for bytes', () => {
    expectEvs(
      () => rec((s) => s.lit(t.bytes, '0x123')),
      EvsTypeError,
      'LITERAL_RANGE',
      /even-length hex/,
    );
  });

  test('wrong literal kind (boolean for uint8)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint8, true as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /number or bigint/,
    );
  });

  test('array literal rules apply element-wise', () => {
    expectEvs(
      () => rec((s) => s.lit(t.array(t.uint8), [1n, 999n])),
      EvsTypeError,
      'LITERAL_RANGE',
      /uint8\[\]\[1\]/,
    );
  });

  test('deferred type in s.lit → UNSUPPORTED_V0', () => {
    expectEvs(
      () => rec((s) => s.lit('uint256[][]' as never, [] as never)),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /not supported in evs v0/,
    );
  });
});

// ---------------------------------------------------------------------------
// operand type mismatches
// ---------------------------------------------------------------------------

describe('checklist: operand type mismatch (message suggests toUint/toInt)', () => {
  test('width mismatch between two numeric Exprs suggests an explicit conversion', () => {
    const e = expectEvs(
      () => rec((s) => s.add(s.args.x, s.lit(t.uint8, 1) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /operand types differ/,
    );
    expect(e.message).toMatch(/toUint|toInt/);
  });

  test('coercing an Expr against an expected type names both types', () => {
    const e = expectEvs(
      () => rec((s) => s.let(t.uint256, s.lit(t.uint8, 1) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expected 'uint256', got Expr<'uint8'>/,
    );
    expect(e.message).toMatch(/toUint\('uint256'\)/);
  });

  test('arithmetic on a non-numeric type', () => {
    expectEvs(
      () => rec((s) => s.add(s.args.who as never, s.args.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be numeric/,
    );
  });

  test('eq on a memref type', () => {
    expectEvs(
      () => rec((s) => s.eq(s.args.xs as never, s.args.xs as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /word types only/,
    );
  });

  test('bool logic on a non-bool', () => {
    expectEvs(
      () => rec((s) => s.and(s.args.x as never, s.args.x as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /Expr<'bool'>/,
    );
  });

  test('bitwise on address', () => {
    expectEvs(
      () => rec((s) => s.bitAnd(s.args.who as never, s.args.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uintN\/bytesN/,
    );
  });

  test('two plain literals: at least one operand must be an Expr', () => {
    expectEvs(
      () => rec((s) => s.add(1n, 2n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /at least one operand must be an Expr/,
    );
  });

  test('shift with a literal shiftee', () => {
    expectEvs(
      () => rec((s) => s.shl(1n as never, 1n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /shifted operand must be an Expr/,
    );
  });

  test('conversion source must be numeric', () => {
    expectEvs(
      () => rec((s) => (s.args.who as Expr<never>).toUint(t.uint256)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /source must be numeric/,
    );
  });

  test('asAddress only from uint256/bytes32', () => {
    expectEvs(
      () => rec((s) => (s.args.s8 as never as Expr<'uint256'>).asAddress()),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uint256'.*bytes32'/,
    );
  });

  test('.length() on a word type / .at() on a non-array', () => {
    expectEvs(
      () => rec((s) => (s.args.x as never as Expr<'bytes'>).length()),
      EvsTypeError,
      'TYPE_MISMATCH',
      /string\/bytes\/T\[\]/,
    );
    expectEvs(
      () => rec((s) => (s.args.x as never as Expr<'uint64[]'>).at(0n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /T\[\] array/,
    );
  });

  test('env with an unknown kind', () => {
    expectEvs(
      () => rec((s) => s.env('origin' as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown kind/,
    );
  });

  test('newArray with a non-word element type', () => {
    expectEvs(
      () => rec((s) => s.newArray('string' as never, 1n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /word type/,
    );
  });

  test('select: both branches literal', () => {
    expectEvs(
      () => rec((s) => s.select(s.args.flag, 1n, 2n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /at least one branch must be an Expr/,
    );
  });

  test('select: branch type mismatch', () => {
    expectEvs(
      () => rec((s) => s.select(s.args.flag, s.args.x, s.args.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /branch types differ/,
    );
  });

  test('while: condition must be a thunk', () => {
    expectEvs(
      () => rec((s) => s.while(true as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /thunk/,
    );
  });

  test('for: range.type must be numeric; from/until required', () => {
    expectEvs(
      () => rec((s) => s.for({ type: t.address, from: 0n, until: 1n } as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be numeric/,
    );
    expectEvs(
      () => rec((s) => s.for({ type: t.uint256, from: 0n } as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /range\.from and range\.until/,
    );
  });

  test('s.let(expr) overload requires an Expr', () => {
    expectEvs(
      () => rec((s) => s.let(5n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /init must be an Expr/,
    );
  });
});

// ---------------------------------------------------------------------------
// certain-panic folds (with the documented escape hatch in the message)
// ---------------------------------------------------------------------------

describe('checklist: all-literal certain-panic folds', () => {
  test('add overflow → Panic(0x11) with the cell escape hatch', () => {
    const e = expectEvs(
      () => rec((s) => s.lit(t.uint8, 255).add(1)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x11\)/,
    );
    expect(e.message).toContain('s.let(t.uint256, x).get()');
  });

  test('sub underflow on unsigned', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint8, 0).sub(1)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /underflows uint8.*Panic\(0x11\)/s,
    );
  });

  test('division by literal zero → Panic(0x12)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 1n).div(0n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x12\)/,
    );
  });

  test('intN min / −1 → Panic(0x11)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.int8, -128n).div(-1n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /overflows int8/,
    );
  });

  test('modulo by literal zero → Panic(0x12)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 1n).mod(0n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x12\)/,
    );
  });

  test('out-of-range narrowing conversion → Panic(0x11)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 300n).toUint(t.uint8)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /does not fit 'uint8'/,
    );
  });

  test('literal asAddress with dirty high bits', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 2n ** 200n).asAddress()),
      EvsTypeError,
      'CERTAIN_PANIC',
      /does not fit 'address'/,
    );
  });

  test('literal newArray length ≥ 2^32 → Panic(0x41)', () => {
    expectEvs(
      () => rec((s) => s.newArray(t.uint256, 2n ** 32n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x41\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.call / s.tryCall ABI checks
// ---------------------------------------------------------------------------

describe('checklist: call-site ABI validation', () => {
  test('abi has no function with that name', () => {
    expectEvs(
      () =>
        rec((s) => s.call({ address: s.args.who, abi: erc20Abi, functionName: 'symbol' as never })),
      EvsTypeError,
      'ABI_SHAPE',
      /no function named "symbol"/,
    );
  });

  test('non view/pure function rejected with its mutability', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.call({
            address: s.args.who,
            abi: erc20Abi,
            functionName: 'transfer' as never,
            args: [s.args.who, 1n] as never,
          }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /is nonpayable.*view\/pure/s,
    );
  });

  test('overloaded name → UNSUPPORTED_V0 with the pruned-ABI workaround', () => {
    const e = expectEvs(
      () => rec((s) => s.call({ address: s.args.who, abi: overloadedAbi, functionName: 'get' })),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /overloaded/,
    );
    expect(e.message).toMatch(/prune the ABI/);
  });

  test('v0-unsupported output type names the parameter', () => {
    const e = expectEvs(
      () => rec((s) => s.call({ address: s.args.who, abi: tupleAbi, functionName: 'observe' })),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /not supported in evs v0/,
    );
    expect(e.message).toMatch(/output parameter "data"/);
    expect(e.message).toMatch(/"observe"/);
  });

  test('argument arity mismatch', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.call({
            address: s.args.who,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [] as never,
          }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects 1 argument\(s\), got 0/,
    );
  });

  test('argument Expr type mismatch names the parameter', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.call({
            address: s.args.who,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [s.args.x as never],
          }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /args\[0\] \("owner"\).*expected 'address'/s,
    );
  });

  test('missing functionName / abi not an array / missing address', () => {
    expectEvs(
      () => rec((s) => s.call({ address: s.args.who, abi: erc20Abi } as never)),
      EvsTypeError,
      'ABI_SHAPE',
      /functionName/,
    );
    expectEvs(
      () => rec((s) => s.call({ address: s.args.who, abi: {}, functionName: 'x' } as never)),
      EvsTypeError,
      'ABI_SHAPE',
      /must be an ABI array/,
    );
    expectEvs(
      () => rec((s) => s.call({ abi: erc20Abi, functionName: 'decimals' } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /`address` is required/,
    );
  });

  test('tryCall shares the same checks', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.tryCall({ address: s.args.who, abi: erc20Abi, functionName: 'nope' as never }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /no function named "nope"/,
    );
  });
});

// ---------------------------------------------------------------------------
// foreign handles + scopes + sealing
// ---------------------------------------------------------------------------

describe('checklist: foreign handle / closed scope / use-after-seal', () => {
  test('cross-script Expr → FOREIGN_HANDLE naming both scripts', () => {
    let foreign: Expr<'uint256'> | undefined;
    evscript({ name: 'donor', args: [arg('v', t.uint256)] }, (s) => {
      foreign = s.args.v;
      return s.return({ v: s.args.v });
    });
    const e = expectEvs(
      () =>
        rec((s) => {
          if (foreign === undefined) throw new Error('unreachable');
          return s.add(s.args.x, foreign);
        }),
      EvsScopeError,
      'FOREIGN_HANDLE',
      /belongs to script "donor".*script "tst"/s,
    );
    expect(e.relatedLocs.length).toBeGreaterThan(0);
    expect(e.relatedLocs[0]?.label).toMatch(/donor/);
  });

  test('forged handle-shaped object → FOREIGN_HANDLE', () => {
    expectEvs(
      () => rec((s) => s.add(s.args.x, { type: 'uint256' } as never)),
      EvsScopeError,
      'FOREIGN_HANDLE',
      /not created by this copy of evs/,
    );
  });

  test('if-branch value used after the branch closes', () => {
    const e = expectEvs(
      () =>
        rec((s) => {
          let leaked: Expr<'uint256'> | undefined;
          s.if(s.args.flag, () => {
            leaked = s.args.x.add(1n);
          });
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ leaked });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /if-then block that has finished recording/,
    );
    expect(e.message).toMatch(/cells \(s\.let\)/);
    expect(e.relatedLocs[0]?.label).toBe('value recorded at');
    expect(e.relatedLocs[0]?.loc?.file).toMatch(/validation\.test\.ts/);
  });

  test('while-body value used after the loop closes', () => {
    expectEvs(
      () =>
        rec((s) => {
          let leaked: Expr<'uint256'> | undefined;
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(s.args.x),
            () => {
              leaked = i.get();
              i.set(s.args.x);
            },
          );
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ leaked });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /while-body block that has finished recording/,
    );
  });

  test('cell declared inside a branch used after it', () => {
    expectEvs(
      () =>
        rec((s) => {
          let leaked: { get(): Expr<'uint256'> } | undefined;
          s.if(s.args.flag, () => {
            leaked = s.let(t.uint256, 1n);
          });
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ v: leaked.get() });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cell was declared in a if-then block/,
    );
  });

  test('builder used after evscript returns → RECORDING_CLOSED', () => {
    let escaped: AnyBuilder | undefined;
    rec((s) => {
      escaped = s;
      return s.return({ x: s.args.x });
    });
    expectEvs(
      () => escaped?.add(escaped.args.x, 1n),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed — s\.return/,
    );
  });

  test('Expr method after seal → RECORDING_CLOSED', () => {
    let x: Expr<'uint256'> | undefined;
    rec((s) => {
      x = s.args.x;
      return s.return({ x: s.args.x });
    });
    expectEvs(() => x?.add(1n), EvsScopeError, 'RECORDING_CLOSED', /sealed/);
  });

  test('builder calls after s.return but inside the callback → RECORDING_CLOSED', () => {
    expectEvs(
      () =>
        rec((s) => {
          const token = s.return({ x: s.args.x });
          s.lit(t.uint256, 1n); // sealed already
          return token;
        }),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.return discipline
// ---------------------------------------------------------------------------

describe('checklist: s.return missing / duplicated / inside a block / bad keys', () => {
  test('missing s.return', () => {
    expectEvs(
      () => rec(() => undefined),
      EvsTypeError,
      'TYPE_MISMATCH',
      /completed without calling s\.return/,
    );
  });

  test('s.return inside s.if → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) => {
          s.if(s.args.flag, () => {
            s.return({ x: s.args.x });
          });
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cannot be recorded inside a if-then block/,
    );
  });

  test('s.return inside a while body → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) => {
          s.while(
            () => s.args.flag,
            () => {
              s.return({ x: s.args.x });
            },
          );
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /while-body/,
    );
  });

  test('duplicated s.return → RECORDING_CLOSED', () => {
    expectEvs(
      () =>
        rec((s) => {
          s.return({ x: s.args.x });
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed/,
    );
  });

  test('callback returning something other than its own s.return token', () => {
    expectEvs(
      () =>
        rec((s) => {
          s.return({ x: s.args.x });
          return {};
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must return the value produced by THIS script's s\.return/,
    );
  });

  test('empty-string return key → ABI_SHAPE', () => {
    expectEvs(
      () => rec((s) => s.return({ '': s.args.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /empty-string return keys/,
    );
  });

  test('non-identifier return key → ABI_SHAPE', () => {
    expectEvs(
      () => rec((s) => s.return({ 'a b': s.args.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /invalid return key/,
    );
  });

  test('literal return values are rejected (Exprs only)', () => {
    expectEvs(
      () => rec((s) => s.return({ x: 1n as never })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be an Expr/,
    );
  });
});

// ---------------------------------------------------------------------------
// LoopCtl scoping
// ---------------------------------------------------------------------------

describe('checklist: LoopCtl outside its loop', () => {
  test('escaped LoopCtl used after the loop → SCOPE_VIOLATION', () => {
    const e = expectEvs(
      () =>
        rec((s) => {
          let escaped: LoopCtl | undefined;
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(s.args.x),
            (loop) => {
              escaped = loop;
              i.set(s.args.x);
            },
          );
          escaped?.break();
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /outside its owning loop/,
    );
    expect(e.relatedLocs[0]?.label).toBe('owning loop recorded at');
  });

  test("outer loop's LoopCtl used inside an inner loop → SCOPE_VIOLATION", () => {
    expectEvs(
      () =>
        rec((s) => {
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(s.args.x),
            (outer) => {
              s.while(
                () => i.get().lt(s.args.x),
                () => {
                  outer.break();
                },
              );
              i.set(s.args.x);
            },
          );
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /belongs to an outer loop/,
    );
  });

  test('LoopCtl inside an s.fn body (isolated stack) → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) => {
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(s.args.x),
            (loop) => {
              s.fn('f', [] as const, () => {
                loop.continue();
              });
              i.set(s.args.x);
            },
          );
          return s.return({ x: s.args.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /outside its owning loop/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.fn discipline
// ---------------------------------------------------------------------------

describe('checklist: s.fn capture / results / params / return-inside', () => {
  test('capturing an outer Expr → SCOPE_VIOLATION naming both locations', () => {
    const e = expectEvs(
      () =>
        rec((s) =>
          s.fn('meta', [arg('token', t.address)] as const, (token) =>
            s.call({
              address: token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [s.args.who], // outer capture!
            }),
          ),
        ),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /s\.fn\("meta"\) bodies cannot capture/,
    );
    expect(e.relatedLocs).toHaveLength(2);
    expect(e.relatedLocs[0]?.label).toBe('captured value recorded at');
    expect(e.relatedLocs[1]?.label).toBe('fn "meta" defined at');
    expect(e.relatedLocs[1]?.loc?.file).toMatch(/validation\.test\.ts/);
  });

  test('capturing an outer Cell → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) => {
          const c = s.let(t.uint256, 0n);
          return s.fn('grab', [] as const, () => c.get());
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cannot capture cells/,
    );
  });

  test('fn body returning a literal → TYPE_MISMATCH', () => {
    expectEvs(
      () => rec((s) => s.fn('bad', [] as const, () => 5n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must return an Expr, a readonly Expr\[\] tuple, or void/,
    );
  });

  test('fn call arity mismatch', () => {
    expectEvs(
      () =>
        rec((s) => {
          const f = s.fn('two', [arg('a', t.uint256), arg('b', t.uint256)] as const, (a, b) =>
            a.add(b),
          );
          return (f as (...args: unknown[]) => unknown)(1n);
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects 2 argument\(s\), got 1/,
    );
  });

  test('duplicate / invalid fn param names; deferred param types', () => {
    expectEvs(
      () => rec((s) => s.fn('d', [arg('a', t.uint256), arg('a', t.uint8)] as const, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /duplicate param name/,
    );
    expectEvs(
      () => rec((s) => s.fn('d', [{ name: 'a', type: 'tuple' }] as never, () => {})),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /not supported in evs v0/,
    );
  });

  test('s.return inside an s.fn body → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.fn('r', [arg('a', t.uint256)] as const, (a) => {
            s.return({ a });
          }),
        ),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /inside an s\.fn body/,
    );
  });

  test('invalid fn name', () => {
    expectEvs(
      () => rec((s) => s.fn('not a name', [] as const, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /non-empty identifier/,
    );
  });
});

// ---------------------------------------------------------------------------
// staging traps (M5 invariant 2)
// ---------------------------------------------------------------------------

/* oxlint-disable typescript/restrict-template-expressions, typescript/no-base-to-string --
 * every flagged expression below is a deliberate staging MISUSE: the trap throwing is the test. */

describe('staging traps', () => {
  function withHandle(run: (x: Expr<'uint256'>) => void): void {
    rec((s) => {
      run(s.args.x);
      return s.return({ x: s.args.x });
    });
  }

  test('x + 1 (primitive coercion) throws EvsStagingError citing the recording site', () => {
    const e = expectEvs(
      () =>
        withHandle((x) => {
          // oxlint-disable-next-line no-unused-expressions -- the misuse IS the test
          (x as never) + 1;
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
    expect(e.relatedLocs[0]?.label).toBe('handle recorded at');
  });

  test('template literal interpolation throws', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          void `${x as never}`;
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
  });

  test('JSON.stringify throws (toJSON trap)', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          JSON.stringify(x);
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /toJSON/,
    );
  });

  test('String(x) throws (toString trap)', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          String(x);
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
  });

  test('node inspect (console.log) is NON-throwing and shows type/id/name', () => {
    rec((s) => {
      const printed = inspect(s.args.x);
      expect(printed).toMatch(/^Expr<uint256> #0 ← args\.x at /);
      const sym = s.call({
        address: s.args.who,
        abi: erc20Abi,
        functionName: 'decimals',
      });
      expect(inspect(sym)).toMatch(/^Expr<uint8> #\d+ ← s\.call\(decimals\) at /);
      return s.return({ x: s.args.x });
    });
  });

  test('a Cell or MutArray where an Expr is expected gets a targeted message', () => {
    expectEvs(
      () =>
        rec((s) => {
          const c = s.let(t.uint256, 0n);
          return s.add(s.args.x, c as never);
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /Cell is not an Expr.*\.get\(\)/s,
    );
    expectEvs(
      () =>
        rec((s) => {
          const a = s.newArray(t.uint256, 1n);
          return s.return({ a: a as never });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /MutArray is not an Expr.*\.expr\(\)/s,
    );
  });
});
