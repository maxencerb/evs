/* oxlint-disable typescript/no-unsafe-type-assertion --
 * a class instance whose members are getters is a struct value at run time, which the
 * `StructLiteral` type does not model: `as never` hands it to the builder as is. */
/**
 * Differential suite — struct values whose members are not own properties.
 *
 * A Svelte 5 `$state` class (private fields behind accessors on the prototype), a class with
 * `get` accessors and an `Object.create(proto)` record are read as JavaScript reads them, in
 * every position that takes a struct value: `s.lit`, `s.let`, `Cell.set`, an array element, a
 * nested member, an `s.fn` argument and `s.tuple`. The interpreter and both compiled outputs on
 * the harness EVM must agree (`expectAgreement`), on the values a plain record gives.
 */

import { getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t } from '../core/types.js';
import { interpret, type MockChain } from '../ir/interp.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the script records no sub-calls');
  },
};

const Position = t.struct({ owner: t.address, amount: t.uint256 });
const Book = t.struct({ id: t.uint256, best: Position, all: t.array(Position) });

/** The shape Svelte 5 compiles `class { owner = $state(); amount = $state() }` to. */
class PositionState {
  #owner: unknown;
  #amount: unknown;
  constructor(owner: unknown, amount: unknown) {
    this.#owner = owner;
    this.#amount = amount;
  }
  get owner(): unknown {
    return this.#owner;
  }
  set owner(value: unknown) {
    this.#owner = value;
  }
  get amount(): unknown {
    return this.#amount;
  }
  set amount(value: unknown) {
    this.#amount = value;
  }
}

/** A domain class that derives a member in a getter (an own key would be an unknown member). */
class Doubled {
  readonly #holder: unknown;
  readonly #half: bigint;
  constructor(holder: unknown, half: bigint) {
    this.#holder = holder;
    this.#half = half;
  }
  get owner(): unknown {
    return this.#holder;
  }
  get amount(): bigint {
    return this.#half * 2n;
  }
}

const CONSTANT_OWNER = '0x00000000000000000000000000000000000000aa';

const script = evscript(
  { name: 'memberReads', args: [t.address, t.uint256] },
  (s, owner, amount) => {
    const viaState = new PositionState(owner, amount);
    const sum = s.fn('sum', Position, (p) => p.amount.get().add(1n));
    const cell = s.let(Position, Object.create({ owner, amount: 1n }) as never);
    cell.set(viaState as never);
    return s.return({
      lit: s.lit(Position, viaState as never),
      constant: s.lit(Position, new Doubled(CONSTANT_OWNER, 21n) as never),
      cell: cell.get(),
      book: s.lit(Book, {
        id: 7n,
        best: new Doubled(owner, 3n),
        all: [viaState, Object.create({ owner, amount: 9n }) as unknown],
      } as never),
      fnArg: sum(viaState as never),
      tuple: s.tuple(Position, new PositionState(owner, undefined) as never),
    });
  },
);

const INPUTS: readonly (readonly [`0x${string}`, bigint])[] = [
  ['0x0000000000000000000000000000000000000011', 5n],
  ['0x00000000000000000000000000000000000000ff', 0n],
];

describe('struct members on the prototype chain', () => {
  test('interpreter and bytecode agree, on the values a plain record gives', async () => {
    const outcomes = await expectAgreement(script, INPUTS);
    expect(outcomes.every((o) => o.kind === 'return')).toBe(true);
    for (const [who, amount] of INPUTS) {
      const owner = getAddress(who);
      const { outcome } = interpret(script, [who, amount], NO_CHAIN);
      expect(outcome.kind).toBe('return');
      if (outcome.kind !== 'return') continue;
      expect(outcome.values).toEqual({
        lit: { owner, amount },
        constant: { owner: getAddress(CONSTANT_OWNER), amount: 42n },
        cell: { owner, amount },
        book: {
          id: 7n,
          best: { owner, amount: 6n },
          all: [
            { owner, amount },
            { owner, amount: 9n },
          ],
        },
        fnArg: amount + 1n,
        tuple: { owner, amount: 0n },
      });
    }
  });
});
