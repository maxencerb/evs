/**
 * A `t.struct` and an ABI tuple with the same members are one type, whatever order the members
 * are written in and whatever order a type checker keeps a union in. TypeScript 7 and its ports
 * sort unions, TypeScript 5 and 6 keep them in creation order: a type that recovers a member order
 * from a union means something different on each.
 *
 * The member order still matters for the encoding. The types cannot see it (an object type has no
 * key order), so recording checks it.
 */
import { evscript, t, type Expr } from '@maxencerb/evs';

import { vaultAbi } from './abi.js';
import { expectType, type Same } from './assert.js';

type Address = `0x${string}`;

// written in Solidity's order, which is not the alphabetical one
const Position = t.struct({ token: t.address, amount: t.uint256 });
// the same members, written the other way round
const PositionReversed = t.struct({ amount: t.uint256, token: t.address });
// three members: none of the six orders is the "natural" one
const Leg = t.struct({ zeta: t.uint256, alpha: t.address, mid: t.bool });
const Book = t.struct({ owner: t.address, positions: t.array(Position) });

// a struct declared from the ABI is the same type as the one written by hand
const PositionFromAbi = t.fromOutputs(vaultAbi, 'positionOf');
expectType<Same<typeof PositionFromAbi, typeof Position>>();
expectType<Same<typeof PositionFromAbi, typeof PositionReversed>>();

// not the same type: a member differs, is missing, or is extra
const PositionNarrow = t.struct({ token: t.address, amount: t.uint128 });
const PositionShort = t.struct({ token: t.address });
const PositionLong = t.struct({ token: t.address, amount: t.uint256, fee: t.uint24 });
const PositionRenamed = t.struct({ asset: t.address, amount: t.uint256 });
expectType<Same<Same<typeof PositionNarrow, typeof Position>, false>>();
expectType<Same<Same<typeof PositionShort, typeof Position>, false>>();
expectType<Same<Same<typeof PositionLong, typeof Position>, false>>();
expectType<Same<Same<typeof PositionRenamed, typeof Position>, false>>();

/** A struct array argument goes to an ABI `tuple[]`, `tuple[2]` or `tuple` parameter. */
export const structsIntoCalls = evscript(
  {
    name: 'structsIntoCalls',
    args: [
      t.address,
      t.array(Position),
      t.array(Position, 2),
      Position,
      t.array(PositionReversed),
      t.array(Leg),
      t.array(Book),
    ],
  },
  (s, vault, positions, pair, one, reversed, legs, books) => {
    const fromArray = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      args: [positions],
    });
    expectType<Same<typeof fromArray, Expr<'uint256'>>>();

    const fromPair = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOfPair',
      args: [pair],
    });
    const fromOne = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOfOne',
      args: [one],
    });
    // accepted by the types; recording compares the member order and rejects this one
    const fromReversed = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      args: [reversed],
    });
    const fromLegs = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOfLegs',
      args: [legs],
    });
    const fromBooks = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOfBooks',
      args: [books],
    });

    // an element is a struct handle with one typed field per member
    const first = positions.at(0n);
    expectType<Same<ReturnType<typeof first.token.get>, Expr<'address'>>>();
    expectType<Same<ReturnType<typeof first.amount.get>, Expr<'uint256'>>>();

    return s.return({ fromArray, fromPair, fromOne, fromReversed, fromLegs, fromBooks });
  },
);

/** A struct array built in the script goes to the same parameters. */
export const builtArrays = evscript(
  { name: 'builtArrays', args: [t.address, t.address] },
  (s, vault, token) => {
    const book = s.newArray(Position, 2n);
    book.set(0n, { token, amount: 1n });
    const fromHandle = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      args: [book],
    });
    const fromExpr = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      args: [book.expr()],
    });
    const fromLiteral = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      args: [[{ token, amount: 2n }]],
    });
    return s.return({ fromHandle, fromExpr, fromLiteral });
  },
);

/** What an ABI returns goes wherever the hand-written struct type is expected. */
export const abiResultsIntoStructs = evscript(
  { name: 'abiResultsIntoStructs', args: [t.address, t.address] },
  (s, vault, owner) => {
    const count = s.fn('count', [t.array(Position)], (positions) => positions.length());
    const amountOf = s.fn('amountOf', [Position], (position) => position.amount.get());

    const many = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'positionsOf',
      args: [owner],
    });
    const one = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'positionOf',
      args: [owner],
    });
    expectType<Same<ReturnType<typeof one.amount.get>, Expr<'uint256'>>>();

    const kept = s.let(t.array(Position), many);
    kept.set(many);
    const out = s.newArray(Position, many.length());
    out.set(0n, one);

    return s.return({
      count: count(many),
      amount: amountOf(one),
      kept: kept.get(),
      out,
      one,
    });
  },
);

/** A struct whose members differ from the ABI's is still a compile error. */
export const mismatchesStayErrors = evscript(
  {
    name: 'mismatchesStayErrors',
    args: [
      t.address,
      t.array(PositionNarrow),
      t.array(PositionShort),
      t.array(PositionLong),
      t.array(PositionRenamed),
      t.array(Leg),
    ],
  },
  (s, vault, narrow, short, long, renamed, legs) => {
    s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      // @ts-expect-error `amount` is a uint128, the ABI takes a uint256
      args: [narrow],
    });
    s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      // @ts-expect-error the struct has no `amount`
      args: [short],
    });
    s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      // @ts-expect-error the struct has a member the ABI does not
      args: [long],
    });
    s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      // @ts-expect-error `asset` is not `token`
      args: [renamed],
    });
    s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'valueOf',
      // @ts-expect-error another struct altogether
      args: [legs],
    });

    const count = s.fn('count', [t.array(Position)], (positions) => positions.length());
    // @ts-expect-error `amount` is a uint128, the parameter's is a uint256
    count(narrow);
    // @ts-expect-error the struct has no `amount`
    count(short);
    // @ts-expect-error the struct has a member the parameter's does not
    count(long);

    return s.return({ vault });
  },
);

// the struct types flow into the script's own ABI, so viem types `args` and the result from it
const compiled = structsIntoCalls.compile();
type Inputs = (typeof compiled.abi)[0]['inputs'];
expectType<Same<Inputs[1]['type'], 'tuple[]'>>();
expectType<Same<Inputs[3]['type'], 'tuple'>>();
expectType<Same<Inputs[1]['components'][number]['name'], 'token' | 'amount'>>();
expectType<Same<Address, `0x${string}`>>();
