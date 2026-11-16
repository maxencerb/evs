// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title NoOutputs — functions that declare no return value
/// @notice The target of the evs "call through a function without outputs" tests
///         (test/integration/strict-decoding.test.ts). A call to one of these decodes nothing,
///         so an evs call site first checks that its target has code, as Solidity does: the
///         tests call them here (the call runs) and at an address without code (it fails).
contract NoOutputs {
    error Refused(uint256 x);

    /// @notice How many times `poke` ran: a simulated poke leaves it unchanged.
    uint256 public pokes;

    /// @dev A validation-style view: returns nothing when `x` is accepted, reverts otherwise.
    function check(uint256 x) external pure {
        if (x == 0) revert Refused(x);
    }

    /// @dev A write without a return value.
    function poke(uint256 x) external payable {
        if (x == 0) revert Refused(x);
        pokes += 1;
    }
}
