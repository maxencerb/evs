// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Malformed} from "../src/Malformed.sol";
import {NoOutputs} from "../src/NoOutputs.sol";
import {StrictDecodeReference} from "../src/StrictDecodeReference.sol";

/// @notice The solc behaviour the evs strict-decoding tests compare against, pinned on its own:
///         the ABI decoder reverts on a word out of range for its type, and a high-level call
///         that decodes nothing reverts on an address without code.
contract StrictDecodeReferenceTest is Test {
    StrictDecodeReference internal ref;
    Malformed internal echo;
    NoOutputs internal noOutputs;

    function setUp() public {
        ref = new StrictDecodeReference();
        echo = new Malformed();
        noOutputs = new NoOutputs();
    }

    function _words(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(a, b, c, d, e);
    }

    function testCleanWordsDecode() public view {
        bytes memory data = _words(1, 0xabcd, 255, uint256(int256(-128)), uint256(0x11223344) << 224);
        (bool a, address b, uint8 c, int8 d, bytes4 e) = ref.words(address(echo), data);
        assertTrue(a);
        assertEq(b, address(0xabcd));
        assertEq(c, 255);
        assertEq(d, -128);
        assertEq(e, bytes4(0x11223344));
    }

    function testDirtyBoolReverts() public {
        vm.expectRevert(bytes(""));
        ref.words(address(echo), _words(2, 0xabcd, 7, 5, 0));
    }

    function testDirtyAddressReverts() public {
        vm.expectRevert(bytes(""));
        ref.words(address(echo), _words(1, 1 << 160, 7, 5, 0));
    }

    function testDirtyUint8Reverts() public {
        vm.expectRevert(bytes(""));
        ref.words(address(echo), _words(1, 0xabcd, 256, 5, 0));
    }

    function testInt8NotSignExtendedReverts() public {
        vm.expectRevert(bytes(""));
        ref.words(address(echo), _words(1, 0xabcd, 7, 0x80, 0));
    }

    function testDirtyBytes4Reverts() public {
        vm.expectRevert(bytes(""));
        ref.words(address(echo), _words(1, 0xabcd, 7, 5, (uint256(0x11223344) << 224) | 1));
    }

    function testDirtyArgumentReverts() public view {
        bytes memory data =
            abi.encodePacked(StrictDecodeReference.argWords.selector, _words(1, 0xabcd, 300, 5, 0));
        (bool ok, bytes memory ret) = address(ref).staticcall(data);
        assertFalse(ok);
        assertEq(ret.length, 0);
    }

    function testCheckRunsOnCode() public view {
        ref.check(address(noOutputs), 1);
    }

    function testCheckRevertsWithoutCode() public {
        vm.expectRevert(bytes(""));
        ref.check(address(0xe0a), 1);
    }
}
