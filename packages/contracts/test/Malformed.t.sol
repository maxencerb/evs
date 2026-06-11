// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Malformed} from "../src/Malformed.sol";

/// @notice Byte-exact sanity checks of the attacker-shaped returndata. Every call is made
///         raw (staticcall) because decoding through a typed Solidity interface would
///         revert in the CALLER — the whole point of these fixtures.
contract MalformedTest is Test {
    Malformed internal m;

    function setUp() public {
        m = new Malformed();
    }

    function _raw(string memory sig) internal view returns (bytes memory) {
        (bool ok, bytes memory data) = address(m).staticcall(abi.encodeWithSignature(sig));
        assertTrue(ok, "malformed fixture must SUCCEED");
        return data;
    }

    function _word(bytes memory data, uint256 index) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(add(data, 0x20), mul(index, 0x20)))
        }
    }

    function testEmptyReturn() public view {
        assertEq(_raw("emptyReturn()").length, 0);
    }

    function testShortWord() public view {
        bytes memory data = _raw("shortWord()");
        assertEq(data.length, 16);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(uint8(data[i]), 0xff);
        }
    }

    function testShortHead() public view {
        bytes memory data = _raw("shortHead()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), 1);
    }

    function testHugeOffset() public view {
        bytes memory data = _raw("hugeOffset()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), 1 << 255);
    }

    function testOffsetPastEnd() public view {
        bytes memory data = _raw("offsetPastEnd()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), 0x200);
    }

    function testHugeLength() public view {
        bytes memory data = _raw("hugeLength()");
        assertEq(data.length, 64);
        assertEq(_word(data, 0), 0x20);
        assertEq(_word(data, 1), 1 << 200);
    }

    function testLengthPastEndByOne() public view {
        bytes memory data = _raw("lengthPastEndByOne()");
        assertEq(data.length, 0x60);
        assertEq(_word(data, 0), 0x20);
        assertEq(_word(data, 1), 33); // needs 0x61 bytes; only 0x60 returned
        assertEq(_word(data, 2), type(uint256).max);
    }

    function testTruncatedArray() public view {
        bytes memory data = _raw("truncatedArray()");
        assertEq(data.length, 0x60);
        assertEq(_word(data, 0), 0x20);
        assertEq(_word(data, 1), 2); // declares 2 elements; only 1 word follows
        assertEq(_word(data, 2), 7);
    }

    function testHugeArrayLength() public view {
        bytes memory data = _raw("hugeArrayLength()");
        assertEq(data.length, 64);
        assertEq(_word(data, 0), 0x20);
        assertEq(_word(data, 1), 1 << 64);
    }

    function testOneByteTooLong() public view {
        bytes memory data = _raw("oneByteTooLong()");
        assertEq(data.length, 33);
        assertEq(_word(data, 0), 42);
        assertEq(uint8(data[32]), 0xff);
    }

    function testDirtyBool() public view {
        bytes memory data = _raw("dirtyBool()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), 2);
    }

    function testDirtyUint8() public view {
        bytes memory data = _raw("dirtyUint8()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), type(uint256).max);
    }

    function testDirtyAddress() public view {
        bytes memory data = _raw("dirtyAddress()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), type(uint256).max);
    }

    function testDirtyInt8() public view {
        bytes memory data = _raw("dirtyInt8()");
        assertEq(data.length, 32);
        assertEq(_word(data, 0), 0x80); // not sign-extended on purpose
    }

    /// @dev External self-call wrappers: the typed decode runs (and reverts) inside THEIR
    ///      frame, so `vm.expectRevert` observes it as a call revert.
    function decodeTruncatedArrayTyped() external view returns (uint256[] memory) {
        return m.truncatedArray();
    }

    function decodeHugeOffsetTyped() external view returns (string memory) {
        return m.hugeOffset();
    }

    /// @dev Decoding through the typed interface must revert in the CALLER — proves the
    ///      fixtures actually violate the declared ABI shapes.
    function testTypedDecodeOfTruncatedArrayRevertsInCaller() public {
        vm.expectRevert();
        this.decodeTruncatedArrayTyped();
    }

    function testTypedDecodeOfHugeOffsetRevertsInCaller() public {
        vm.expectRevert();
        this.decodeHugeOffsetTyped();
    }
}
