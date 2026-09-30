// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {EvsMathReference} from "../src/EvsMathReference.sol";

/// @notice Sanity checks pinning the EvsMathReference oracle to the boundaries the evs `pow` /
///         `addmod` / `mulmod` / signed-shift lowerings must reproduce (issue #10).
contract EvsMathReferenceTest is Test {
    EvsMathReference internal ref;

    function setUp() public {
        ref = new EvsMathReference();
    }

    function testPowHappyPaths() public view {
        assertEq(ref.powU256(0, 0), 1);
        assertEq(ref.powU256(1, type(uint256).max), 1);
        assertEq(ref.powU256(2, 255), 2 ** 255);
        assertEq(ref.powU8(15, 2), 225);
        assertEq(ref.powI8(-2, 7), -128);
        assertEq(ref.powI256(-2, 255), type(int256).min);
        assertEq(ref.powI256(-1, type(uint256).max), -1);
        assertEq(ref.powBase2(255), 2 ** 255);
        assertEq(ref.powBaseNeg2(255), type(int256).min);
        assertEq(ref.powBaseNeg3I8(4), 81);
        assertEq(ref.powExp3I256(-3), -27);
    }

    function testPowU256Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.powU256(2, 256);
    }

    function testPowI8PositiveOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.powI8(2, 7);
    }

    function testPowI256MinSquaredOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.powI256(type(int256).min, 2);
    }

    function testPowBase2Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.powBase2(256);
    }

    function testPowHugeExponent() public view {
        assertEq(ref.powExpHugeU256(0), 0);
        assertEq(ref.powExpHugeU256(1), 1);
        assertEq(ref.powExpMaxI64(-1), -1);
        assertEq(ref.powExpHugeEvenI8(-1), 1);
    }

    function testPowHugeExponentOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.powExpMaxI64(-2);
    }

    function testModArithHappyPaths() public view {
        uint256 max = type(uint256).max;
        assertEq(ref.addmodU256(max, max, 10), 0); // (2^257 - 2) % 10 == 0
        assertEq(ref.mulmodU256(max, max, max - 1), 1);
        assertEq(ref.mulmodConst(2, 3), 6);
    }

    function testAddmodZeroModulus() public {
        vm.expectRevert(stdError.divisionError);
        ref.addmodU256(1, 2, 0);
    }

    function testMulmodZeroModulus() public {
        vm.expectRevert(stdError.divisionError);
        ref.mulmodU256(1, 2, 0);
    }

    function testSignedShifts() public view {
        assertEq(ref.shrI8(-3, 1), -2); // arithmetic: rounds toward negative infinity
        assertEq(ref.shlI8(127, 1), -2); // wraps into the sign bit, re-sign-extended
        assertEq(ref.shrI256(-5, 300), -1);
        assertEq(ref.shlI256(1, 255), type(int256).min);
    }
}
