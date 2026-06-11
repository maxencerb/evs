// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {EvsReference} from "../src/EvsReference.sol";

/// @notice Sanity checks pinning the EvsReference oracle to the architecture.md §6
///         boundary semantics: happy paths compute, every documented edge case reverts
///         with the exact Panic code the evs codegen must reproduce.
contract EvsReferenceTest is Test {
    EvsReference internal ref;

    function setUp() public {
        ref = new EvsReference();
    }

    // ---------------------------------------------------------------- add
    function testAddHappyPaths() public view {
        assertEq(ref.addU8(1, 2), 3);
        assertEq(ref.addU64(type(uint64).max - 1, 1), type(uint64).max);
        assertEq(ref.addU128(0, 0), 0);
        assertEq(ref.addU192(type(uint192).max, 0), type(uint192).max);
        assertEq(ref.addU256(2 ** 255, 2 ** 255 - 1), type(uint256).max);
        assertEq(ref.addI8(-128, 127), -1);
        assertEq(ref.addI128(type(int128).min, 1), type(int128).min + 1);
        assertEq(ref.addI200(-1, 1), 0);
        assertEq(ref.addI256(type(int256).min, type(int256).max), -1);
    }

    function testAddU8Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.addU8(255, 1);
    }

    function testAddU256Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.addU256(type(uint256).max, 1);
    }

    function testAddI8PositiveOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.addI8(127, 1);
    }

    function testAddI8NegativeOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.addI8(-128, -1);
    }

    function testAddI256NegativeOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.addI256(type(int256).min, -1);
    }

    // ---------------------------------------------------------------- sub
    function testSubHappyPaths() public view {
        assertEq(ref.subU64(5, 5), 0);
        assertEq(ref.subU256(type(uint256).max, type(uint256).max - 1), 1);
        assertEq(ref.subI200(type(int200).min, type(int200).min), 0);
        assertEq(ref.subI256(-1, type(int256).max), type(int256).min);
    }

    function testSubU64Underflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.subU64(0, 1);
    }

    function testSubU192Underflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.subU192(1, 2);
    }

    function testSubI256Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.subI256(type(int256).min, 1);
    }

    function testSubI8Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.subI8(-128, 1);
    }

    // ---------------------------------------------------------------- mul
    function testMulHappyPaths() public view {
        assertEq(ref.mulU8(15, 17), 255);
        assertEq(ref.mulU128(2 ** 64, 2 ** 63), 2 ** 127);
        assertEq(ref.mulU192(2 ** 95, 2 ** 96), 2 ** 191);
        assertEq(ref.mulU256(2 ** 128, 2 ** 127), 2 ** 255);
        assertEq(ref.mulI8(-8, 16), -128);
        assertEq(ref.mulI200(-5, 3), -15);
        assertEq(ref.mulI256(type(int256).min, 1), type(int256).min);
        assertEq(ref.mulI256(type(int256).max, -1), type(int256).min + 1);
    }

    /// @dev THE uint192 wrap-back case: a = 2**191, b = 2**65 + 1 — the 256-bit product
    ///      wraps to exactly 2**191 (in range!); a range check alone would miss it.
    function testMulU192WrapBack() public {
        uint192 a = uint192(2 ** 191);
        uint192 b = uint192(2 ** 65 + 1);
        vm.expectRevert(stdError.arithmeticError);
        ref.mulU192(a, b);
    }

    function testMulU192PlainOverflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulU192(type(uint192).max, 2);
    }

    function testMulU8Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulU8(16, 16);
    }

    function testMulU256Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulU256(2 ** 128, 2 ** 128);
    }

    function testMulI200MinTimesMinusOne() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulI200(type(int200).min, -1);
    }

    function testMulI256MinTimesMinusOne() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulI256(type(int256).min, -1);
    }

    /// @dev The lone case the sdiv-back test misses: a == -1, b == -2**255.
    function testMulI256MinusOneTimesMin() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulI256(-1, type(int256).min);
    }

    function testMulI8Overflow() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.mulI8(-128, -1);
    }

    // ---------------------------------------------------------------- div
    function testDivHappyPaths() public view {
        assertEq(ref.divU8(255, 2), 127);
        assertEq(ref.divU256(type(uint256).max, 1), type(uint256).max);
        // Signed division truncates toward zero.
        assertEq(ref.divI256(7, -2), -3);
        assertEq(ref.divI256(-7, 2), -3);
        assertEq(ref.divI200(type(int200).min, 1), type(int200).min);
        assertEq(ref.divI8(-128, 2), -64);
    }

    function testDivU64ByZero() public {
        vm.expectRevert(stdError.divisionError);
        ref.divU64(1, 0);
    }

    function testDivU256ByZero() public {
        vm.expectRevert(stdError.divisionError);
        ref.divU256(0, 0);
    }

    function testDivI256ByZero() public {
        vm.expectRevert(stdError.divisionError);
        ref.divI256(type(int256).min, 0);
    }

    /// @dev int256 edge: -2**255 / -1 — EVM SDIV silently wraps; solc panics 0x11.
    function testDivI256MinByMinusOne() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.divI256(type(int256).min, -1);
    }

    function testDivI200MinByMinusOne() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.divI200(type(int200).min, -1);
    }

    function testDivI8MinByMinusOne() public {
        vm.expectRevert(stdError.arithmeticError);
        ref.divI8(-128, -1);
    }

    // ---------------------------------------------------------------- mod
    function testModHappyPaths() public view {
        assertEq(ref.modU8(255, 16), 15);
        assertEq(ref.modU192(2 ** 191, 3), 2 ** 191 % 3);
        // Signed modulo takes the sign of the dividend.
        assertEq(ref.modI256(-7, 2), -1);
        assertEq(ref.modI256(7, -2), 1);
        assertEq(ref.modI8(-128, 3), -2);
    }

    /// @dev mod never overflows: minN % -1 == 0, NO panic (pins §6 "SMOD: zero-check only").
    function testModMinByMinusOneIsZero() public view {
        assertEq(ref.modI8(-128, -1), 0);
        assertEq(ref.modI200(type(int200).min, -1), 0);
        assertEq(ref.modI256(type(int256).min, -1), 0);
    }

    function testModU128ByZero() public {
        vm.expectRevert(stdError.divisionError);
        ref.modU128(1, 0);
    }

    function testModI256ByZero() public {
        vm.expectRevert(stdError.divisionError);
        ref.modI256(-1, 0);
    }

    // ---------------------------------------------------------------- conversions
    /// @dev Documents the divergence: solc explicit casts truncate (evs narrows checked).
    function testToU8Truncates() public view {
        assertEq(ref.toU8(300), 44);
        assertEq(ref.toU8(type(uint256).max), 255);
    }
}
