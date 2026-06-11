// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockUniV3Pool} from "../src/MockUniV3Pool.sol";
import {Reverter} from "../src/Reverter.sol";

contract MockERC20Test is Test {
    MockERC20 internal token;

    function setUp() public {
        token = new MockERC20("Wrapped Ether", "WETH", 18);
    }

    function testMetadata() public view {
        assertEq(token.name(), "Wrapped Ether");
        assertEq(token.symbol(), "WETH");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0);
    }

    function testMintAndBalances() public {
        token.mint(address(0xA11CE), 100e18);
        assertEq(token.balanceOf(address(0xA11CE)), 100e18);
        assertEq(token.totalSupply(), 100e18);
    }

    function testTransfer() public {
        token.mint(address(this), 10);
        assertTrue(token.transfer(address(0xB0B), 4));
        assertEq(token.balanceOf(address(this)), 6);
        assertEq(token.balanceOf(address(0xB0B)), 4);
    }

    function testTransferInsufficientBalanceReverts() public {
        vm.expectRevert(bytes("MockERC20: insufficient balance"));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(address(0xB0B), 1);
    }

    function testApproveAndTransferFrom() public {
        token.mint(address(this), 10);
        token.approve(address(0xB0B), 7);
        assertEq(token.allowance(address(this), address(0xB0B)), 7);
        vm.prank(address(0xB0B));
        assertTrue(token.transferFrom(address(this), address(0xCAFE), 5));
        assertEq(token.allowance(address(this), address(0xB0B)), 2);
        assertEq(token.balanceOf(address(0xCAFE)), 5);
    }

    function testTransferFromInsufficientAllowanceReverts() public {
        token.mint(address(this), 10);
        token.approve(address(0xB0B), 1);
        vm.prank(address(0xB0B));
        vm.expectRevert(bytes("MockERC20: insufficient allowance"));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transferFrom(address(this), address(0xCAFE), 5);
    }
}

contract MockUniV3PoolTest is Test {
    address internal constant TOKEN0 = address(0x1111);
    address internal constant TOKEN1 = address(0x2222);
    MockUniV3Pool internal pool;

    function setUp() public {
        pool = new MockUniV3Pool(TOKEN0, TOKEN1, 3000, 60);
    }

    function testImmutableGetters() public view {
        assertEq(pool.token0(), TOKEN0);
        assertEq(pool.token1(), TOKEN1);
        assertEq(pool.fee(), 3000);
        assertEq(pool.tickSpacing(), 60);
        assertEq(pool.liquidity(), 0);
    }

    function testSlot0Defaults() public view {
        (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        ) = pool.slot0();
        assertEq(sqrtPriceX96, 0);
        assertEq(tick, 0);
        assertEq(observationIndex, 0);
        assertEq(observationCardinality, 0);
        assertEq(observationCardinalityNext, 0);
        assertEq(feeProtocol, 0);
        assertTrue(unlocked);
    }

    function testSetSlot0RoundTrip() public {
        pool.setSlot0(79228162514264337593543950336, -887272, 3, 100, 200, 4, false);
        (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        ) = pool.slot0();
        assertEq(sqrtPriceX96, 79228162514264337593543950336);
        assertEq(tick, -887272);
        assertEq(observationIndex, 3);
        assertEq(observationCardinality, 100);
        assertEq(observationCardinalityNext, 200);
        assertEq(feeProtocol, 4);
        assertFalse(unlocked);
    }

    function testSetLiquidity() public {
        pool.setLiquidity(type(uint128).max);
        assertEq(pool.liquidity(), type(uint128).max);
    }
}

contract ReverterTest is Test {
    Reverter internal reverter;

    function setUp() public {
        reverter = new Reverter();
    }

    function testRevertErrorString() public {
        vm.expectRevert(bytes("Reverter: error string"));
        reverter.revertErrorString();
    }

    function testRevertRequire() public {
        vm.expectRevert(bytes("Reverter: require failed"));
        reverter.revertRequire();
    }

    function testPanicAssert() public {
        vm.expectRevert(stdError.assertionError);
        reverter.panicAssert();
    }

    function testPanicOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        reverter.panicOverflow();
    }

    function testPanicDivZero() public {
        vm.expectRevert(stdError.divisionError);
        reverter.panicDivZero();
    }

    function testPanicArrayOob() public {
        vm.expectRevert(stdError.indexOOBError);
        reverter.panicArrayOob();
    }

    function testRevertCustomError() public {
        vm.expectRevert(
            abi.encodeWithSelector(Reverter.DetailedError.selector, 42, address(0xBEEF))
        );
        reverter.revertCustomError();
    }

    function testRevertCustomErrorNoArgs() public {
        vm.expectRevert(Reverter.PlainError.selector);
        reverter.revertCustomErrorNoArgs();
    }

    /// @dev Asserts the EMPTY revert payload byte-exactly via a raw call.
    function testRevertEmptyHasNoData() public {
        (bool ok, bytes memory data) =
            address(reverter).call(abi.encodeWithSelector(Reverter.revertEmpty.selector));
        assertFalse(ok);
        assertEq(data.length, 0);
    }

    /// @dev Pins the exact Error(string) payload bytes (what evs must bubble verbatim).
    function testRevertErrorStringPayloadBytes() public {
        (bool ok, bytes memory data) =
            address(reverter).call(abi.encodeWithSelector(Reverter.revertErrorString.selector));
        assertFalse(ok);
        assertEq(data, abi.encodeWithSignature("Error(string)", "Reverter: error string"));
    }

    /// @dev Pins the exact 36-byte Panic(uint256) payload.
    function testPanicOverflowPayloadBytes() public {
        (bool ok, bytes memory data) =
            address(reverter).call(abi.encodeWithSelector(Reverter.panicOverflow.selector));
        assertFalse(ok);
        assertEq(data.length, 36);
        assertEq(data, abi.encodeWithSignature("Panic(uint256)", 0x11));
    }
}
