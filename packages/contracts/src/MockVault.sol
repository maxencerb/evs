// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockVault — a writable fixture for the issue #1 mutable-call surface (s.call / s.simulate)
/// @notice `deposit` is a real NONPAYABLE write: it mutates storage and returns a value. The view
///         getters `totalShares` / `balanceOf` let a test OBSERVE whether a write persisted —
///         `s.call(deposit)` followed by `s.read(totalShares)` in the same script sees the mutation
///         (a plain CALL frame), whereas `s.simulate(deposit)` rolls the write back so the later
///         read sees the original value while still reading back the returned shares.
///         `depositOrRevert` reverts on a zero amount to exercise the strict-bubble / try paths.
contract MockVault {
    uint256 public totalShares;
    mapping(address => uint256) public balanceOf;

    /// @notice Mint `amount * 2` shares to msg.sender; returns the shares minted. NONPAYABLE — it
    ///         touches storage, so it cannot run under STATICCALL (it is not callable via s.read).
    function deposit(uint256 amount) external returns (uint256 shares) {
        shares = amount * 2;
        totalShares += shares;
        balanceOf[msg.sender] += shares;
    }

    /// @notice Same as {deposit} but reverts on a zero amount — for the strict-bubble / try tests.
    function depositOrRevert(uint256 amount) external returns (uint256 shares) {
        require(amount != 0, "ZERO_AMOUNT");
        shares = amount * 2;
        totalShares += shares;
        balanceOf[msg.sender] += shares;
    }
}
