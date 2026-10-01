// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {EvsCastReference} from "../src/EvsCastReference.sol";

/// @notice Sanity checks pinning the EvsCastReference oracle to the semantics the evs address /
///         fixed-bytes conversions and string/bytes byte access must reproduce.
contract EvsCastReferenceTest is Test {
    EvsCastReference internal ref;

    function setUp() public {
        ref = new EvsCastReference();
    }

    function testOrdering() public view {
        (bool lt,,, bool gte) = ref.orderAddress(address(1), address(type(uint160).max));
        assertTrue(lt);
        assertFalse(gte);
        // bytes compare byte by byte from the left: 0xff000000 > 0x00ffffff
        (lt,,,) = ref.orderBytes4(0xff000000, 0x00ffffff);
        assertFalse(lt);
        (address token0, address token1) = ref.sortTokens(address(9), address(3));
        assertEq(token0, address(3));
        assertEq(token1, address(9));
    }

    function testWordConversions() public view {
        assertEq(ref.addressToUint160(address(0xabc)), 0xabc);
        assertEq(ref.uint160ToAddress(0xabc), address(0xabc));
        assertEq(ref.bytes4ToUint32(0xdeadbeef), 0xdeadbeef);
        assertEq(ref.uint32ToBytes4(0x01020304), bytes4(0x01020304));
        assertEq(ref.bytes1ToUint8(0x80), 0x80);
    }

    function testByteAccess() public view {
        assertEq(ref.byteAtString("abc", 2), bytes1("c"));
        assertEq(ref.sliceBytes(hex"0102030405", 1, 3), hex"0203");
        assertEq(ref.sliceBytesFrom(hex"0102030405", 4), hex"05");
        assertEq(ref.sliceString("hello", 1, 4), "ell");
    }

    function testByteAtOutOfRangePanics() public {
        vm.expectRevert(stdError.indexOOBError);
        ref.byteAtBytes(hex"0102", 2);
    }

    function testBytesNToStringTrimsTrailingZeros() public view {
        assertEq(ref.bytes32ToString("MKR"), "MKR");
        assertEq(ref.bytes32ToString(bytes32(0)), "");
        assertEq(ref.bytes4ToString(0x41004200), "A\x00B");
    }
}
