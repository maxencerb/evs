/**
 * `ir/interp.ts` — the reference interpreter over `ScriptIr` against a `MockChain`.
 *
 * A barrel over `ir/interp/`, which mirrors the codegen split:
 * - `interpreter.ts` — the public interface (`interpret`, `MockChain`, …) and the `Interp`
 *   statement executor;
 * - `values.ts` — constants, the environment defaults, the value model, the revert / loop
 *   signals and the byte / type helpers;
 * - `arith.ts` — checked arithmetic, word ops, conversions and the const / env / zero values;
 * - `encode.ts` / `decode.ts` — the ABI encode shapes and the returndata decode;
 * - `coerce.ts` — the JS boundary: script-arg coercion in, JS value projection out.
 *
 * It is the differential oracle for the compiler and implements the canonical word invariant,
 * the checked-arithmetic rules (see binOp), the call semantics (bubbling, staticMinSize guard,
 * decode bounds, normalization, tryCall zeroing) and the ABI encode shapes.
 *
 * Binding invariant: bit-for-bit agreement with the compiled bytecode on both returndata and
 * revert payloads. Consequences baked in here:
 *
 * - Every word value is held as its canonical 256-bit slot image (uintN zero-extended, intN
 *   sign-extended two's complement, bool ∈ {0,1}, bytesN left-aligned, address 160-bit
 *   zero-extended) and every operation re-establishes the invariant exactly where the codegen
 *   templates do.
 * - Checked arithmetic implements the op table via exact bigint math + range check on the
 *   true result. For canonical operands this is *provably identical* to the table's EVM-level
 *   checks: the width cases (div-back for `uintN, N>128` MUL; the lone `int256 −1 × −2^255`
 *   case; SIGNEXTEND fixpoints; the explicit `int256 −2^255 / −1` SDIV check) are exactly the
 *   conditions under which the true result leaves the operand type's range. `pow` is the exact
 *   power under the same range check (every solc `**` template computes exactly that), and
 *   `addmod`/`mulmod` the exact `(a op b) % n` (ADDMOD/MULMOD never wrap). Panic codes:
 *   0x11 overflow, 0x12 div/mod by zero, 0x32 bounds, 0x41 over-allocation.
 * - ABI bytes (sub-call calldata, return tuple, revert payloads) are constructed manually over
 *   raw bytes — never through a UTF-8 round trip — so callee-provided non-UTF-8 `string`
 *   payloads survive byte-exactly. The shapes are standard ABI, byte-equal to viem's
 *   `encodeFunctionData` / `encodeAbiParameters` for valid values (differential-tested).
 * - Memrefs (string/bytes/T[]) have reference semantics: `select`, cells, fn params/results
 *   copy pointers, exactly like the slot-copying codegen.
 *
 * Environment ops: `MockChain` deliberately has no environment surface, so `env` statements
 * default to the constants the unit-tier harness (`test/harness/evm.ts` on `@ethereumjs/evm`
 * defaults) exposes to the compiled bytecode: `address` = the fixed SCRIPT address
 * (`0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`), `caller` =
 * `0x1000000000000000000000000000000000000001`, `timestamp` = 0, `blocknumber` = 0,
 * `chainid` = 1 (Mainnet default common). Those defaults match the stateOverride `toViem()`
 * frame shape; `opts.env` overrides them per call so other frames — notably the DEFAULT
 * deployless mode, where `caller` is viem's internal wrapper contract and `address` is a
 * per-script counterfactual CREATE2 address — can be modeled and differential-tested
 * (the `InterpEnvOverrides` opts).
 *
 * Host-side misuse (wrong arg arity, uncoercible arg values, malformed `MockChain` replies)
 * throws `EvsTypeError`; exceeding `maxSteps` (default 1,000,000; one step per executed
 * statement + one per loop iteration) throws `EvsCompileError(COMPILE_LIMIT)`. Neither is a
 * chain outcome. `validateIr` runs on entry, so garbage IR fails loudly instead of diverging.
 */

export { interpret } from './interp/interpreter.js';
export type { MockChain, InterpResult, InterpEnvOverrides } from './interp/interpreter.js';
