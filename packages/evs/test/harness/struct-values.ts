/**
 * A struct kept in a cell, picked with `s.select` and typed with `s.lit`: the script, its inputs
 * and a host-side reference, shared by the unit differential test (interpreter and bytecode on
 * the harness EVM) and the anvil one. Every struct those three hand back is a `Tuple` handle, so
 * the script reads a member of each, passes a selected struct to `s.select` again, and compares
 * two of them with `s.eq`.
 */
import { evscript } from '../../src/builder/script.js';
import { t } from '../../src/core/types.js';

export const Position = t.struct({ owner: t.address, amount: t.uint256 });

/** One position, as the script takes and returns it. */
export interface PositionValue {
  readonly owner: `0x${string}`;
  readonly amount: bigint;
}

/** What {@link structValuesScript} returns for one input. */
export interface StructValuesResult {
  readonly cellOwner: `0x${string}`;
  readonly cellAmount: bigint;
  readonly pickedAmount: bigint;
  readonly pickedExprOwner: `0x${string}`;
  readonly litAmount: bigint;
  readonly againAmount: bigint;
  readonly same: boolean;
  readonly kept: PositionValue;
}

/** The struct values under test. A cell starts at the second position and takes the first when
 *  `first` is set; `s.select` picks between the two handles and between their memrefs; `s.lit`
 *  builds a struct from staged members; a selected struct is selected again. */
export const structValuesScript = evscript(
  { name: 'structValues', args: [t.bool, Position, Position] },
  (s, first, a, b) => {
    const kept = s.let(Position, b);
    s.if(first, () => kept.set(a));
    const fromCell = kept.get();
    const picked = s.select(first, a, b);
    const pickedExpr = s.select(first, a.expr(), b.expr());
    const lit = s.lit(Position, { owner: a.owner.get(), amount: s.add(b.amount.get(), 1n) });
    const again = s.select(first, picked, lit);
    return s.return({
      cellOwner: fromCell.owner.get(),
      cellAmount: fromCell.amount.get(),
      pickedAmount: picked.amount.get(),
      pickedExprOwner: pickedExpr.owner.get(),
      litAmount: lit.amount.get(),
      againAmount: again.amount.get(),
      same: s.eq(fromCell, picked),
      kept: kept.get(),
    });
  },
);

const OWNER_A = '0x00000000000000000000000000000000000000aa';
const OWNER_B = '0x000000000000000000000000000000000000bEEF';

/** Inputs: both choices, equal and distinct positions, a zero and a large amount (one below the
 *  maximum, so `amount + 1` does not overflow). */
export const STRUCT_VALUES_INPUTS: readonly (readonly [boolean, PositionValue, PositionValue])[] = [
  [true, { owner: OWNER_A, amount: 1n }, { owner: OWNER_B, amount: 2n }],
  [false, { owner: OWNER_A, amount: 1n }, { owner: OWNER_B, amount: 2n }],
  [true, { owner: OWNER_B, amount: 0n }, { owner: OWNER_B, amount: 0n }],
  [false, { owner: OWNER_A, amount: 2n ** 256n - 2n }, { owner: OWNER_B, amount: 2n ** 255n }],
];

/** What the script computes, on the host. */
export function structValuesReference(
  first: boolean,
  a: PositionValue,
  b: PositionValue,
): StructValuesResult {
  const chosen = first ? a : b;
  const lit = { owner: a.owner, amount: b.amount + 1n };
  return {
    cellOwner: chosen.owner,
    cellAmount: chosen.amount,
    pickedAmount: chosen.amount,
    pickedExprOwner: chosen.owner,
    litAmount: lit.amount,
    againAmount: first ? chosen.amount : lit.amount,
    same: true,
    kept: chosen,
  };
}
