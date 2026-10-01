// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockWETH — the WETH9 deposit/withdraw surface, a target that PAYS ETH to its caller
/// @notice `withdraw` burns the caller's balance and sends the ETH back with
///         `payable(msg.sender).transfer(wad)` — WETH9's exact push: a bare call (empty calldata)
///         into the caller carrying only the 2,300-gas stipend. A script that `s.call`s it is
///         that caller, so it must accept empty calldata cheaply; `withdraw(0)` still makes the
///         (zero-value) bare call, so it exercises the path without any balance.
contract MockWETH {
    mapping(address account => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "MockWETH: insufficient balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }
}
