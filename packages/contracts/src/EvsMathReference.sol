// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title EvsMathReference — solc oracle for checked `**`, `addmod` / `mulmod` and signed shifts
/// @notice The ground truth for evs `pow`, `addmod`, `mulmod` and the intN `shl` / `shr`
///         (issue #10), asserted by test/integration/math-ops.test.ts: identical results and
///         byte-identical Panic payloads. A separate contract from EvsReference so both stay
///         well under EIP-170 with the optimizer off.
///
///         `pow{U|I}{bits}` take a runtime base and a runtime exponent of the same width (a
///         narrower exponent than the base draws solc warning 3149, and the 256-bit variants
///         cover exponents past 255); `powBase*` have a literal base (solc's literal-base
///         template), `powExp*` a literal exponent; then the `addmod` / `mulmod` builtins and
///         the signed shifts.
contract EvsMathReference {
    // ---------------------------------------------------------------- runtime base ** exponent
    function powU8(uint8 a, uint8 e) external pure returns (uint8) {
        return a ** e;
    }

    function powU64(uint64 a, uint64 e) external pure returns (uint64) {
        return a ** e;
    }

    function powU192(uint192 a, uint192 e) external pure returns (uint192) {
        return a ** e;
    }

    function powU256(uint256 a, uint256 e) external pure returns (uint256) {
        return a ** e;
    }

    function powI8(int8 a, uint8 e) external pure returns (int8) {
        return a ** e;
    }

    function powI64(int64 a, uint64 e) external pure returns (int64) {
        return a ** e;
    }

    function powI200(int200 a, uint200 e) external pure returns (int200) {
        return a ** e;
    }

    /// @dev int256 edges: (-2)**255 == type(int256).min fits, 2**255 overflows.
    function powI256(int256 a, uint256 e) external pure returns (int256) {
        return a ** e;
    }

    // ---------------------------------------------------------------- literal base
    /// @dev solc's literal-base template: `gt(e, 255)` then `exp(2, e)`.
    function powBase2(uint256 e) external pure returns (uint256) {
        return 2 ** e;
    }

    function powBase10(uint256 e) external pure returns (uint256) {
        return 10 ** e;
    }

    /// @dev A negative literal base is typed int256.
    function powBaseNeg2(uint256 e) external pure returns (int256) {
        return (-2) ** e;
    }

    function powBase3U8(uint8 e) external pure returns (uint8) {
        return uint8(3) ** e;
    }

    function powBaseNeg3I8(uint8 e) external pure returns (int8) {
        return int8(-3) ** e;
    }

    // ---------------------------------------------------------------- literal exponent
    function powExp2I8(int8 a) external pure returns (int8) {
        return a ** 2;
    }

    function powExp3I256(int256 a) external pure returns (int256) {
        return a ** 3;
    }

    function powExp3U64(uint64 a) external pure returns (uint64) {
        return a ** 3;
    }

    // ---------------------------------------------------------------- addmod / mulmod
    function addmodU256(uint256 a, uint256 b, uint256 n) external pure returns (uint256) {
        return addmod(a, b, n);
    }

    function mulmodU256(uint256 a, uint256 b, uint256 n) external pure returns (uint256) {
        return mulmod(a, b, n);
    }

    function mulmodConst(uint256 a, uint256 b) external pure returns (uint256) {
        return mulmod(a, b, 1_000_000_007);
    }

    // ---------------------------------------------------------------- signed shifts
    function shlI8(int8 a, uint8 n) external pure returns (int8) {
        return a << n;
    }

    /// @dev Arithmetic shift: rounds toward negative infinity.
    function shrI8(int8 a, uint8 n) external pure returns (int8) {
        return a >> n;
    }

    function shlI256(int256 a, uint256 n) external pure returns (int256) {
        return a << n;
    }

    function shrI256(int256 a, uint256 n) external pure returns (int256) {
        return a >> n;
    }
}
