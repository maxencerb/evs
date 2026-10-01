/**
 * Differential suite — dead revert guards: scripts whose ONLY reverting statement is dead.
 *
 * The rest of the corpus never lets a dead statement revert, so the recorded IR and its DCE
 * output agree there. Here each script computes a checked op (add/sub/mul/div/mod/pow, signed
 * div, addmod/mulmod), a narrowing or cross-signedness conversion, `asAddress`, a bounds-checked
 * read or write, a length guard or a pure `s.fn` call whose result nothing reads, with one arg
 * set that makes it revert and one that does not.
 * `compile()` lowers `eliminateDeadCode(ir)`, so the bytecode returns; `interpret(script.ir)`
 * runs the same pass by default and must agree byte-for-byte, while
 * `interpret(script.ir, …, { dce: false })` still executes the recorded guard and panics.
 * Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { describe, expect, test } from 'vite-plus/test';

import { chainOf, expectAgreement, panicData } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { namedArg, t } from '../core/types.js';
import { interpret } from '../ir/interp.js';

const MAX = (1n << 256n) - 1n;
const INT_MIN = -(1n << 255n);
const NO_CALLS = chainOf({});

/** A script whose dead statement reverts with `Panic(panic)` for `trips`, and does not for `ok`. */
interface DeadGuardCase {
  readonly script: Parameters<typeof expectAgreement>[0];
  readonly ok: readonly unknown[];
  readonly trips: readonly unknown[];
  readonly panic: bigint;
}

const CASES: Record<string, DeadGuardCase> = {
  'checked add (overflow)': {
    script: evscript({ name: 'deadAdd', args: [t.uint256] }, (s, a) => {
      a.add(1n); // unused
      return s.return({ a });
    }),
    ok: [5n],
    trips: [MAX],
    panic: 0x11n,
  },
  'checked sub (underflow)': {
    script: evscript({ name: 'deadSub', args: [t.uint256, t.uint256] }, (s, a, b) => {
      a.sub(b); // unused
      return s.return({ a });
    }),
    ok: [2n, 1n],
    trips: [1n, 2n],
    panic: 0x11n,
  },
  'checked div (by zero)': {
    script: evscript({ name: 'deadDiv', args: [t.uint256, t.uint256] }, (s, a, b) => {
      a.div(b); // unused
      return s.return({ a });
    }),
    ok: [5n, 1n],
    trips: [5n, 0n],
    panic: 0x12n,
  },
  'checked mul (overflow)': {
    script: evscript({ name: 'deadMul', args: [t.uint256] }, (s, a) => {
      a.mul(2n); // unused
      return s.return({ a });
    }),
    ok: [5n],
    trips: [MAX],
    panic: 0x11n,
  },
  'checked mod (by zero)': {
    script: evscript({ name: 'deadMod', args: [t.uint256, t.uint256] }, (s, a, b) => {
      a.mod(b); // unused
      return s.return({ a });
    }),
    ok: [5n, 3n],
    trips: [5n, 0n],
    panic: 0x12n,
  },
  'checked pow (overflow)': {
    script: evscript({ name: 'deadPow', args: [t.uint256, t.uint256] }, (s, a, e) => {
      a.pow(e); // unused
      return s.return({ a });
    }),
    ok: [2n, 10n],
    trips: [2n, 256n],
    panic: 0x11n,
  },
  'signed div (MIN / -1)': {
    script: evscript({ name: 'deadSdiv', args: [t.int256, t.int256] }, (s, a, b) => {
      a.div(b); // unused
      return s.return({ a });
    }),
    ok: [INT_MIN, 1n],
    trips: [INT_MIN, -1n],
    panic: 0x11n,
  },
  'addmod (modulus zero)': {
    script: evscript({ name: 'deadAddmod', args: [t.uint256, t.uint256] }, (s, a, n) => {
      a.addmod(1n, n); // unused
      return s.return({ a });
    }),
    ok: [5n, 3n],
    trips: [5n, 0n],
    panic: 0x12n,
  },
  'mulmod (modulus zero)': {
    script: evscript({ name: 'deadMulmod', args: [t.uint256, t.uint256] }, (s, a, n) => {
      a.mulmod(2n, n); // unused
      return s.return({ a });
    }),
    ok: [5n, 3n],
    trips: [5n, 0n],
    panic: 0x12n,
  },
  'narrowing convert': {
    script: evscript({ name: 'deadNarrow', args: [t.uint256] }, (s, a) => {
      a.toUint(t.uint64); // unused
      return s.return({ a });
    }),
    ok: [7n],
    trips: [1n << 64n],
    panic: 0x11n,
  },
  'uint256 → int256 (cross-signedness)': {
    script: evscript({ name: 'deadToInt', args: [t.uint256] }, (s, a) => {
      a.toInt(t.int256); // unused
      return s.return({ a });
    }),
    ok: [7n],
    trips: [1n << 255n],
    panic: 0x11n,
  },
  'int256 → uint256 (negative)': {
    script: evscript({ name: 'deadToUint', args: [t.int256] }, (s, a) => {
      a.toUint(t.uint256); // unused
      return s.return({ a });
    }),
    ok: [7n],
    trips: [-1n],
    panic: 0x11n,
  },
  'asAddress (high bits set)': {
    script: evscript({ name: 'deadAsAddress', args: [t.uint256] }, (s, a) => {
      a.asAddress(); // unused
      return s.return({ a });
    }),
    ok: [7n],
    trips: [1n << 160n],
    panic: 0x11n,
  },
  'array index (out of bounds)': {
    script: evscript({ name: 'deadIndex', args: [t.array(t.uint256), t.uint256] }, (s, xs, i) => {
      xs.at(i); // unused
      return s.return({ i });
    }),
    ok: [[7n], 0n],
    trips: [[], 0n],
    panic: 0x32n,
  },
  'array set (out of bounds, array never read)': {
    script: evscript({ name: 'deadArrset', args: [t.uint256, t.uint256] }, (s, n, i) => {
      const ys = s.newArray(t.uint256, n); // nothing reads ys
      ys.set(i, 1n); // unused write
      return s.return({ i });
    }),
    ok: [1n, 0n],
    trips: [1n, 1n],
    panic: 0x32n,
  },
  's.newArray length guard': {
    script: evscript({ name: 'deadNewArray', args: [t.uint256] }, (s, n) => {
      s.newArray(t.uint256, n); // unused
      return s.return({ n });
    }),
    ok: [3n],
    trips: [1n << 32n],
    panic: 0x41n,
  },
  'pure s.fn call': {
    script: evscript({ name: 'deadFn', args: [t.uint256] }, (s, a) => {
      const inc = s.fn('inc', [namedArg('x', t.uint256)] as const, (x) => x.add(1n));
      inc(a); // unused
      return s.return({ a });
    }),
    ok: [5n],
    trips: [MAX],
    panic: 0x11n,
  },
};

describe('dead revert guards — interpret() follows the shipped bytecode', () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(`dead ${name}: the bytecode and interpret() return, the recorded IR panics`, async () => {
      // `ok` keeps the full recorded-IR == interpret() == bytecode check; `trips` (index 1) is
      // the arg set where only the recorded IR runs the dead guard
      const outcomes = await expectAgreement(c.script, [c.ok, c.trips], {}, 'cancun', {
        deadRevertGuards: [1],
      });
      // the bytecode and interpret(script.ir) both return for the tripping args …
      expect(outcomes.map((o) => o.kind)).toEqual(['return', 'return']);
      // … while the recorded IR still executes the guard, with the documented Panic code
      expect(interpret(c.script.ir, c.trips, NO_CALLS, { dce: false }).outcome).toEqual({
        kind: 'revert',
        data: panicData(c.panic),
      });
    });
  }

  test('the CERTAIN_PANIC escape hatch only panics when its result is used', async () => {
    // `s.lit(t.uint8, 255).add(1)` is refused at recording; through a cell it records a guard
    const used = evscript({ name: 'used', args: [] }, (s) =>
      s.return({ r: s.let(t.uint8, 255n).get().add(1n) }),
    );
    const unused = evscript({ name: 'unused', args: [] }, (s) => {
      s.let(t.uint8, 255n).get().add(1n); // unused: dropped, cell included
      return s.return({ r: s.lit(t.uint8, 1n) });
    });
    expect(await expectAgreement(used, [[]])).toEqual([{ kind: 'revert', data: panicData(0x11n) }]);
    const [o] = await expectAgreement(unused, [[]], {}, 'cancun', { deadRevertGuards: [0] });
    expect(o?.kind).toBe('return');
    expect(interpret(unused.ir, [], NO_CALLS, { dce: false }).outcome.kind).toBe('revert');
  });

  test('the same checked add feeding the return keeps its Panic on every side', async () => {
    const script = evscript({ name: 'liveAdd', args: [t.uint256] }, (s, a) =>
      s.return({ r: a.add(1n) }),
    );
    const [, tripped] = await expectAgreement(script, [[5n], [MAX]]);
    expect(tripped).toEqual({ kind: 'revert', data: panicData(0x11n) });
  });
});
