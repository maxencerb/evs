// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Reverter — the revert-bubbling suite's callee
/// @notice Every revert flavor an evs script can encounter from a callee, each behind its
///         own selector (testing.md §4.3): Error(string) via revert/require, Panic via
///         assert / overflow / div-by-zero / array OOB, custom errors (with and without
///         arguments), and the empty revert. evs strict `s.call` must bubble each payload
///         verbatim; viem must surface the callee's error through the script unchanged.
contract Reverter {
    /// @dev Custom error with arguments — bubbled byte-exact through evs scripts.
    error DetailedError(uint256 code, address who);

    /// @dev Zero-argument custom error (4-byte revert payload).
    error PlainError();

    /// @notice Reverts `Error("Reverter: error string")` via `revert(string)`.
    function revertErrorString() external pure returns (uint256) {
        revert("Reverter: error string");
    }

    /// @notice Reverts `Error("Reverter: require failed")` via a failing `require`.
    function revertRequire() external pure returns (uint256 r) {
        require(r == 1, "Reverter: require failed");
    }

    /// @notice Reverts `Panic(0x01)` via a failing `assert`.
    function panicAssert() external pure returns (uint256 r) {
        assert(r == 1);
    }

    /// @notice Reverts `Panic(0x11)` via checked uint256 overflow.
    function panicOverflow() external pure returns (uint256) {
        uint256 x = type(uint256).max;
        uint256 one = 1;
        return x + one;
    }

    /// @notice Reverts `Panic(0x12)` via division by zero.
    function panicDivZero() external pure returns (uint256) {
        uint256 zero = 0;
        return 1 / zero;
    }

    /// @notice Reverts `Panic(0x32)` via an out-of-bounds array index.
    function panicArrayOob() external pure returns (uint256) {
        uint256[] memory arr = new uint256[](1);
        uint256 idx = 2;
        return arr[idx];
    }

    /// @notice Reverts `DetailedError(42, 0x000000000000000000000000000000000000bEEF)`.
    function revertCustomError() external pure returns (uint256) {
        revert DetailedError(42, address(0xBEEF));
    }

    /// @notice Reverts `PlainError()` — a 4-byte custom-error payload.
    function revertCustomErrorNoArgs() external pure returns (uint256) {
        revert PlainError();
    }

    /// @notice Reverts with EMPTY returndata (`revert()`).
    function revertEmpty() external pure returns (uint256) {
        revert();
    }
}
