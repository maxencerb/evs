// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockVault} from "../src/MockVault.sol";
import {MockQuoter} from "../src/MockQuoter.sol";

/// @notice Behavioural pins for the issue #1 mutable-call fixtures (MockVault / MockQuoter).
contract MockVaultTest is Test {
    MockVault internal vault;

    function setUp() public {
        vault = new MockVault();
    }

    function testDepositMutatesAndReturns() public {
        uint256 shares = vault.deposit(100);
        assertEq(shares, 200);
        assertEq(vault.totalShares(), 200);
        assertEq(vault.balanceOf(address(this)), 200);
    }

    function testDepositAccumulates() public {
        vault.deposit(10);
        vault.deposit(5);
        assertEq(vault.totalShares(), 30);
    }

    function testDepositOrRevertReverts() public {
        vm.expectRevert(bytes("ZERO_AMOUNT"));
        vault.depositOrRevert(0);
        assertEq(vault.totalShares(), 0);
    }
}

contract MockQuoterTest is Test {
    MockQuoter internal quoter;

    function setUp() public {
        quoter = new MockQuoter();
    }

    function testQuoteExactInputReturns() public {
        assertEq(quoter.quoteExactInput(100), 150);
    }

    function testQuoteRevertsWithEncodedResult() public {
        (bool ok, bytes memory data) =
            address(quoter).call(abi.encodeWithSelector(MockQuoter.quoteExactInputReverting.selector, uint256(100)));
        assertFalse(ok);
        assertEq(abi.decode(data, (uint256)), 150);
    }
}
