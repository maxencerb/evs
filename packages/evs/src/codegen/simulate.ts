/**
 * `codegen/simulate.ts` — the `s.simulate` / `s.trySimulate` self-call trampoline (issue #1).
 *
 * `s.simulate` dry-runs a true WRITE and reads back its return value, with the write's state
 * **rolled back** and isolated from later reads in the same script. The only EVM primitive that
 * produces a revertable sub-frame without CREATE (forbidden) is a CALL to self that reverts: the
 * script CALLs **its own address** at a reserved trampoline entrypoint; the trampoline performs
 * the real CALL to the write target and then REVERTs with the target's returndata, so when its
 * frame unwinds every state change the target made is discarded. The outer frame catches the
 * revert, recognizes a magic prefix, and decodes the carried returndata like a normal result.
 *
 * Self-CALLing `ADDRESS()` works in BOTH `toViem()` modes: deployless (the CREATEd counterfactual
 * contract holds the runtime at `ADDRESS()`) and stateOverride (the code is set at the override
 * address). The trampoline runs in its own frame and never touches the main frame's memory.
 *
 * Wire format (set by `emitSimulateCall` in `codegen/call.ts`):
 *   self-call calldata : [trampSel(4)][target(32)][gas(32)][ targetCalldata… ]   (payload at 0x44)
 *   trampoline revert  : [MAGIC(32)][innerSuccess(32)][ target returndata… ]
 *
 * The magic word lets the outer frame tell an intentional simulate-revert from a genuine failure
 * (out-of-gas, codeless self) — the latter has no magic and is reported as a decode failure; the
 * `innerSuccess` word distinguishes a successful dry-run (decode the outputs) from a reverting
 * target (strict: bubble the target's revert; try: `success = false`).
 *
 * Gas: the self-call hop always forwards all gas (`GAS`); the `gas` word is the cap for the INNER
 * target CALL — the site's `gas` option when given, else `2^256 − 1`, which the EVM clamps to the
 * all-but-one-64th rule (EIP-150) exactly like `GAS` would. Capping the inner CALL rather than the
 * hop keeps the trampoline's epilogue (the MAGIC-tagged REVERT) funded even when a gas-hungry
 * target burns its whole allowance: the target's out-of-gas surfaces as `innerSuccess = 0`, never
 * as a lost MAGIC.
 *
 * Re-entrancy: the trampoline is a self-contained dispatcher entrypoint that runs in its own
 * frame with its own memory, so it composes freely — a simulate site inside an `s.fn` body, one
 * simulate feeding the next, or a target that itself re-enters the script through the same
 * selector all nest naturally (every hop is a fresh CALL frame that unwinds on its own REVERT).
 */

import { AsmWriter, type LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import type { Hex } from '../core/types.js';

/**
 * Reserved 4-byte trampoline selector — `toFunctionSelector('__evs_simulate(address,bytes)')`.
 * A keccak-derived value so an accidental collision with a user function's selector is ~2^-32;
 * `lowerProgram` additionally asserts it differs from the script's own selector.
 */
export const SIMULATE_TRAMPOLINE_SELECTOR: Hex = '0xbbde5aa3';

/** Numeric form of {@link SIMULATE_TRAMPOLINE_SELECTOR} for the dispatcher `EQ`. */
export const SIMULATE_TRAMPOLINE_SELECTOR_NUM = 0xbbde5aa3;

/**
 * 32-byte sentinel prefixing every trampoline revert — `keccak256("evs.simulate.revert.v1")`.
 * The outer frame requires `MLOAD(snapshot) === MAGIC` before trusting the carried returndata.
 */
export const SIMULATE_MAGIC = 0xe7dc6cc8acb6dfffe16c5466c82c888cde4d25c3f822bd2740efb87faa5dda3cn;

/**
 * Byte length of the self-call wire header `[trampSel(4)][target(32)][gas(32)]` — the calldata
 * offset at which the target payload starts. Shared with `emitSimulateCall` (codegen/call.ts),
 * which lays the header out on the outer side.
 */
export const SIMULATE_PAYLOAD_OFFSET = 68;

/** PUSH20 0xff…ff — masks a raw word down to a canonical 20-byte address. */
const ADDRESS_MASK = (1n << 160n) - 1n;

/**
 * Emits the trampoline entrypoint body at `entry` (a checked label at stack height 0, reached
 * from the dispatcher; terminates in REVERT). Self-contained — uses fixed scratch offsets
 * (0x80/0xa0/0xc0) in its own frame, so it needs neither the free pointer nor the shared tails.
 */
export function emitSimulateTrampoline(
  w: AsmWriter,
  entry: LabelId,
  _opts: { evmVersion: EvmVersion },
): void {
  // The dispatcher reaches this entry via `DUP1 … EQ JUMPI`, which leaves the matched selector on
  // the stack (it is reused for the main-selector compare on the fall-through path) — so the edge
  // carries one item. Annotate height 1 and drop it.
  w.label(entry, 1, 'simulate_trampoline');
  w.op('POP'); // discard the leftover selector

  // L = CALLDATASIZE − 68 (the target payload length; payload starts at calldata offset 0x44,
  // after [sel(4)][target(32)][gas(32)]).
  w.push(SIMULATE_PAYLOAD_OFFSET, { note: 'payload offset' });
  w.op('CALLDATASIZE');
  w.op('SUB'); // [L]

  // CALLDATACOPY(dest = 0x80, offset = 0x44, size = L) — copy the target payload into memory.
  w.op('DUP1'); // [L, L]
  w.push(SIMULATE_PAYLOAD_OFFSET);
  w.push(0x80);
  w.op('CALLDATACOPY', { note: 'copy target payload' }); // [L]

  // success = CALL(gas, target, value = 0, argsOffset = 0x80, argsSize = L, retOffset = 0, retSize = 0)
  // push bottom-up: retSize, retOffset, argsSize, argsOffset, value, addr, gas
  w.push(0); // [retSize=0, L]
  w.push(0); // [retOff=0, 0, L]
  w.op('DUP3'); // [argsSize=L, 0, 0, L]
  w.push(0x80); // [argsOff=0x80, L, 0, 0, L]
  w.push(0, { note: 'value 0' }); // [value=0, …]
  w.push(0x04);
  w.op('CALLDATALOAD'); // [target_raw, …]
  w.push(ADDRESS_MASK, { note: 'mask address' });
  w.op('AND'); // [target, …]
  // the inner gas cap travels in the wire header: the site's `gas` option, or 2^256−1 (= forward
  // all under the EIP-150 clamp) when none was given — the hop itself always forwards GAS.
  w.push(0x24);
  w.op('CALLDATALOAD', { note: 'inner gas cap (2^256−1 = forward all)' }); // [gas, target, …]
  w.op('CALL', { note: 'CALL the write target (rolled back on REVERT below)' }); // [success, L]

  // Build the revert payload [MAGIC(32)][success(32)][returndata…] at 0x80 and REVERT it. The
  // REVERT unwinds this frame, discarding every state change the target made — the rollback.
  w.push(SIMULATE_MAGIC, { note: 'simulate magic' });
  w.push(0x80);
  w.op('MSTORE'); // mem[0x80] = MAGIC ; [success, L]
  w.push(0xa0);
  w.op('MSTORE'); // mem[0xa0] = success ; [L]
  w.push(0xc0); // [0xc0, L]
  w.returndatacopyAll({ dupDepth: 1 }); // mem[0xc0..] = target returndata ; [0xc0, L]
  w.op('RETURNDATASIZE');
  w.push(0x40);
  w.op('ADD'); // [64 + rds, 0xc0, L]
  w.push(0x80); // [0x80, 64+rds, 0xc0, L]
  w.op('REVERT', { note: 'roll back the write; carry [MAGIC][success][returndata]' });
}
