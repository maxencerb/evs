// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Overloaded — overloaded view/pure functions for evs overload resolution (issue #4)
/// @notice Every `get` overload returns a different type, so a script that resolves the wrong
///         overload fails to decode (or decodes a visibly different value). `get(bytes32)` is
///         NONPAYABLE: it competes only under `s.call` / `s.simulate`, never under `s.read`.
contract Overloaded {
    struct Position {
        uint256 id;
        address owner;
    }

    uint256 private _nonce;

    /// @notice `get()` → a constant.
    function get() external pure returns (uint256) {
        return 7;
    }

    /// @notice `get(uint256)` → `x * 2`.
    function get(uint256 x) external pure returns (uint256) {
        return x * 2;
    }

    /// @notice `get(uint8)` → `bytes32(x + 100)` (a different return type from `get(uint256)`).
    function get(uint8 x) external pure returns (bytes32) {
        return bytes32(uint256(x) + 100);
    }

    /// @notice `get(address)` → whether `who` is non-zero.
    function get(address who) external pure returns (bool) {
        return who != address(0);
    }

    /// @notice `get(string)` → the string's byte length.
    function get(string calldata s) external pure returns (uint256) {
        return bytes(s).length;
    }

    /// @notice `get(uint256,uint256)` → named `(sum, product)`.
    function get(uint256 a, uint256 b) external pure returns (uint256 sum, uint256 product) {
        return (a + b, a * b);
    }

    /// @notice `get((uint256,address))` → the position echoed back with `id + 1`.
    function get(Position calldata p) external pure returns (uint256 id, address owner) {
        return (p.id + 1, p.owner);
    }

    /// @notice NONPAYABLE `get(bytes32)` → `h` (touches storage so it needs a real CALL frame).
    function get(bytes32 h) external returns (bytes32) {
        _nonce++;
        return h;
    }
}
