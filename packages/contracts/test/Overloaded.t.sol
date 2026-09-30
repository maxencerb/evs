// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Overloaded} from "../src/Overloaded.sol";

contract OverloadedTest is Test {
    Overloaded internal ov;

    function setUp() public {
        ov = new Overloaded();
    }

    function testEachOverload() public {
        assertEq(ov.get(), 7);
        assertEq(ov.get(uint256(21)), 42);
        // `ov.get(uint8(5))` is ambiguous to solc itself (uint8 converts to uint256): go by signature
        (bool ok, bytes memory ret) = address(ov).staticcall(abi.encodeWithSignature("get(uint8)", uint8(5)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes32)), bytes32(uint256(105)));
        assertTrue(ov.get(address(0xA11CE)));
        assertFalse(ov.get(address(0)));
        assertEq(ov.get(string("hello")), 5);
        (uint256 sum, uint256 product) = ov.get(3, 4);
        assertEq(sum, 7);
        assertEq(product, 12);
        (uint256 id, address owner) = ov.get(Overloaded.Position({id: 9, owner: address(0xB0B)}));
        assertEq(id, 10);
        assertEq(owner, address(0xB0B));
        assertEq(ov.get(bytes32(uint256(0xff))), bytes32(uint256(0xff)));
    }
}
