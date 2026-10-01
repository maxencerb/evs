// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {EvsFullMathReference} from "../src/EvsFullMathReference.sol";

/// @notice Sanity checks pinning the EvsFullMathReference oracle to the boundaries the evs
///         wrapping-arithmetic and `mulDiv` lowerings must reproduce.
contract EvsFullMathReferenceTest is Test {
    EvsFullMathReference internal ref;

    function setUp() public {
        ref = new EvsFullMathReference();
    }

    function testWrapping() public view {
        assertEq(ref.wrapAddU8(250, 10), 4);
        assertEq(ref.wrapSubU256(0, 1), type(uint256).max);
        assertEq(ref.wrapMulU256(type(uint256).max, type(uint256).max), 1);
        assertEq(ref.wrapAddI8(127, 1), -128);
        assertEq(ref.wrapMulI256(type(int256).min, -1), type(int256).min);
    }

    function testMulDiv() public view {
        uint256 max = type(uint256).max;
        assertEq(ref.mulDiv(5, 7, 3), 11);
        assertEq(ref.mulDivRoundingUp(5, 7, 3), 12);
        assertEq(ref.mulDiv(max, max, max), max);
        assertEq(ref.mulDiv(1 << 128, 1 << 128, 2), 1 << 255);
        // 2^257 / 3, past one word
        assertEq(
            ref.mulDiv(1 << 255, 4, 3), 77194726158210796949047323339125271902179989777093709359638389338608753093290
        );
    }

    /// @dev Any product that fits one word is plain division.
    function testFuzzMulDivFitsOneWord(uint128 x, uint128 y, uint256 d) public view {
        vm.assume(d != 0);
        assertEq(ref.mulDiv(x, y, d), (uint256(x) * y) / d);
    }

    function testMulDivZeroDenominator() public {
        vm.expectRevert(stdError.divisionError);
        ref.mulDiv(1, 2, 0);
        vm.expectRevert(stdError.divisionError);
        ref.mulDiv(1 << 255, 4, 0);
    }

    function testMulDivOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulDiv(type(uint256).max, type(uint256).max, type(uint256).max - 1);
    }

    function testMulDivRoundingUpOverflow() public {
        // the floor is exactly type(uint256).max, with a remainder
        uint256 x = 535006138814359;
        uint256 y = 432862656469423142931042426214547535783388063929571229938474969;
        assertEq(ref.mulDiv(x, y, 2), type(uint256).max);
        vm.expectRevert(stdError.arithmeticError);
        ref.mulDivRoundingUp(x, y, 2);
    }
}
