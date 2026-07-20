// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title EvsReference — solc checked-arithmetic differential oracle
/// @notice One external pure function per (op x width class) used by the evs differential
///         suite (testing.md §4.3). solc 0.8.30 checked semantics (optimizer off, via_ir off)
///         IS the ground truth that pins the architecture.md §6 table: identical
///         success/revert outcomes and identical Panic(code) payloads are asserted against
///         the equivalent evs scripts for boundary operands
///         (0, 1, max-1, max, min, -1, the uint192 wrap-back case 2**191 * (2**65 + 1),
///         and the signed edge cases int256: -2**255 / -1, intN: minN / -1).
contract EvsReference {
    // ---------------------------------------------------------------- add
    function addU8(uint8 a, uint8 b) external pure returns (uint8) {
        return a + b;
    }

    function addU64(uint64 a, uint64 b) external pure returns (uint64) {
        return a + b;
    }

    function addU128(uint128 a, uint128 b) external pure returns (uint128) {
        return a + b;
    }

    function addU192(uint192 a, uint192 b) external pure returns (uint192) {
        return a + b;
    }

    function addU256(uint256 a, uint256 b) external pure returns (uint256) {
        return a + b;
    }

    function addI8(int8 a, int8 b) external pure returns (int8) {
        return a + b;
    }

    function addI128(int128 a, int128 b) external pure returns (int128) {
        return a + b;
    }

    function addI200(int200 a, int200 b) external pure returns (int200) {
        return a + b;
    }

    function addI256(int256 a, int256 b) external pure returns (int256) {
        return a + b;
    }

    // ---------------------------------------------------------------- sub
    function subU8(uint8 a, uint8 b) external pure returns (uint8) {
        return a - b;
    }

    function subU64(uint64 a, uint64 b) external pure returns (uint64) {
        return a - b;
    }

    function subU128(uint128 a, uint128 b) external pure returns (uint128) {
        return a - b;
    }

    function subU192(uint192 a, uint192 b) external pure returns (uint192) {
        return a - b;
    }

    function subU256(uint256 a, uint256 b) external pure returns (uint256) {
        return a - b;
    }

    function subI8(int8 a, int8 b) external pure returns (int8) {
        return a - b;
    }

    function subI128(int128 a, int128 b) external pure returns (int128) {
        return a - b;
    }

    function subI200(int200 a, int200 b) external pure returns (int200) {
        return a - b;
    }

    function subI256(int256 a, int256 b) external pure returns (int256) {
        return a - b;
    }

    // ---------------------------------------------------------------- mul
    function mulU8(uint8 a, uint8 b) external pure returns (uint8) {
        return a * b;
    }

    function mulU64(uint64 a, uint64 b) external pure returns (uint64) {
        return a * b;
    }

    function mulU128(uint128 a, uint128 b) external pure returns (uint128) {
        return a * b;
    }

    /// @dev The 128 < N < 256 width class where the 256-bit product can wrap back into
    ///      range (a = 2**191, b = 2**65 + 1 => a*b == 2**191 (mod 2**256)); architecture §6
    ///      mandates div-back AND range check — this function is the solc oracle for it.
    function mulU192(uint192 a, uint192 b) external pure returns (uint192) {
        return a * b;
    }

    function mulU256(uint256 a, uint256 b) external pure returns (uint256) {
        return a * b;
    }

    function mulI8(int8 a, int8 b) external pure returns (int8) {
        return a * b;
    }

    function mulI128(int128 a, int128 b) external pure returns (int128) {
        return a * b;
    }

    /// @dev Signed 128 < N < 256 width class (int256 overflow check then fixpoint check).
    function mulI200(int200 a, int200 b) external pure returns (int200) {
        return a * b;
    }

    function mulI256(int256 a, int256 b) external pure returns (int256) {
        return a * b;
    }

    // ---------------------------------------------------------------- div
    function divU8(uint8 a, uint8 b) external pure returns (uint8) {
        return a / b;
    }

    function divU64(uint64 a, uint64 b) external pure returns (uint64) {
        return a / b;
    }

    function divU128(uint128 a, uint128 b) external pure returns (uint128) {
        return a / b;
    }

    function divU192(uint192 a, uint192 b) external pure returns (uint192) {
        return a / b;
    }

    function divU256(uint256 a, uint256 b) external pure returns (uint256) {
        return a / b;
    }

    function divI8(int8 a, int8 b) external pure returns (int8) {
        return a / b;
    }

    function divI128(int128 a, int128 b) external pure returns (int128) {
        return a / b;
    }

    function divI200(int200 a, int200 b) external pure returns (int200) {
        return a / b;
    }

    /// @dev int256 edge: -2**255 / -1 must Panic 0x11 (EVM SDIV silently wraps it).
    function divI256(int256 a, int256 b) external pure returns (int256) {
        return a / b;
    }

    // ---------------------------------------------------------------- mod
    function modU8(uint8 a, uint8 b) external pure returns (uint8) {
        return a % b;
    }

    function modU64(uint64 a, uint64 b) external pure returns (uint64) {
        return a % b;
    }

    function modU128(uint128 a, uint128 b) external pure returns (uint128) {
        return a % b;
    }

    function modU192(uint192 a, uint192 b) external pure returns (uint192) {
        return a % b;
    }

    function modU256(uint256 a, uint256 b) external pure returns (uint256) {
        return a % b;
    }

    function modI8(int8 a, int8 b) external pure returns (int8) {
        return a % b;
    }

    function modI128(int128 a, int128 b) external pure returns (int128) {
        return a % b;
    }

    function modI200(int200 a, int200 b) external pure returns (int200) {
        return a % b;
    }

    /// @dev minI256 % -1 == 0 in solc (mod never overflows) — pinned by the sanity tests.
    function modI256(int256 a, int256 b) external pure returns (int256) {
        return a % b;
    }

    // ---------------------------------------------------------------- conversions
    /// @dev NOT used for narrowing parity: evs narrows CHECKED (Panic 0x11 out of range),
    ///      solc explicit casts TRUNCATE. Kept to DOCUMENT the divergence (testing.md §4.3).
    function toU8(uint256 x) external pure returns (uint8) {
        // The truncation IS the point of this function (documented divergence fixture).
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(x);
    }

    // ---------------------------------------------------------------- abi.encode /
    // abi.encodePacked / keccak256 (issue #17): solc 0.8.30 is the ground truth the
    // s.encode / s.encodePacked / s.keccak256 differential suite (testing.md §4.4)
    // asserts byte-identical results against.
    struct EncPair {
        address token;
        uint24 fee;
    }

    struct EncOrder {
        uint256 id;
        string label;
        uint128[] amounts;
    }

    function encodeWords(uint8 a, int64 b, address c, bool d, bytes32 e)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(a, b, c, d, e);
    }

    function encodeDyn(string calldata s, bytes calldata b, uint256[] calldata arr)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(s, b, arr);
    }

    function encodeStruct(EncPair calldata pair, EncOrder calldata order)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(pair, order);
    }

    function encodeComposite(
        string[] calldata strs,
        uint256[][] calldata grid,
        EncPair[] calldata pairs
    ) external pure returns (bytes memory) {
        return abi.encode(strs, grid, pairs);
    }

    function packedWords(uint8 a, int64 b, address c, bool d, bytes3 e)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(a, b, c, d, e);
    }

    function packedDyn(string calldata s, bytes calldata b, uint16[] calldata arr)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(s, b, arr);
    }

    function hashBytes(bytes calldata b) external pure returns (bytes32) {
        return keccak256(b);
    }

    function hashPacked(uint8 a, uint256 x, string calldata s) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, x, s));
    }

    function hashEncoded(uint256 x, string calldata s) external pure returns (bytes32) {
        return keccak256(abi.encode(x, s));
    }
}
