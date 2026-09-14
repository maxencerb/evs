// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Shapes} from "../src/Shapes.sol";

/// @notice Pins the exact shape/values every Shapes getter returns, so the evs differential and
///         integration suites can assume them. Each assertion mirrors the deterministic derivation
///         in Shapes.sol field-for-field.
contract ShapesTest is Test {
    Shapes internal c;

    function setUp() public {
        c = new Shapes();
    }

    function testPair() public view {
        uint256[2] memory p = c.pair(21);
        assertEq(p[0], 21);
        assertEq(p[1], 42);
    }

    function testAddrs3() public view {
        address[3] memory a = c.addrs3(0x10);
        assertEq(a[0], address(uint160(0x11)));
        assertEq(a[1], address(uint160(0x12)));
        assertEq(a[2], address(uint160(0x13)));
    }

    function testPositions2() public view {
        Shapes.Position[2] memory ps = c.positions2(5);
        assertEq(ps[0].nonce, 5);
        assertEq(ps[0].operator, address(uint160(16)));
        assertEq(ps[0].liquidity, 5007);
        assertEq(ps[1].nonce, 6);
        assertEq(ps[1].liquidity, 6007);
    }

    function testNames2() public view {
        string[2] memory ns = c.names2(12);
        assertEq(ns[0], "12");
        assertEq(ns[1], "12-12");
    }

    function testPairsAndCols() public view {
        uint256[2][] memory ps = c.pairs(3);
        assertEq(ps.length, 3);
        assertEq(ps[2][0], 2);
        assertEq(ps[2][1], 20);
        uint256[][2] memory cs = c.cols(2);
        assertEq(cs[0].length, 2);
        assertEq(cs[1].length, 3);
        assertEq(cs[0][1], 1);
        assertEq(cs[1][2], 102);
    }

    function testFixedArgs() public view {
        uint256[2] memory p = [uint256(3), uint256(4)];
        assertEq(c.sumPair(p), 7);
        uint256[2] memory e = c.echoPair(p);
        assertEq(e[1], 4);
        uint256[2][] memory ps = new uint256[2][](2);
        ps[0] = [uint256(1), uint256(2)];
        ps[1] = [uint256(3), uint256(4)];
        assertEq(c.sumPairs(ps), 10);
        string[2] memory ns = ["a", "bc"];
        string[2] memory en = c.echoNames2(ns);
        assertEq(en[1], "bc");
    }

    function testPositionsGrid() public view {
        Shapes.Position[][] memory g = c.positionsGrid(4);
        assertEq(g.length, 4);
        assertEq(g[0].length, 1);
        assertEq(g[1].length, 2);
        assertEq(g[2].length, 3);
        assertEq(g[3].length, 1);
        assertEq(g[2][1].nonce, 21);
        assertEq(g[2][1].liquidity, 21007);
        assertEq(c.sumGridLiquidity(g), 7 + (10007 + 11007) + (20007 + 21007 + 22007) + 30007);
        Shapes.Position[][] memory e = c.echoGrid(g);
        assertEq(e[3][0].nonce, 30);
    }

    function testWithBytesGrid() public view {
        Shapes.WithBytes[][] memory g = c.withBytesGrid(3);
        assertEq(g.length, 3);
        assertEq(g[0].length, 1);
        assertEq(g[1].length, 2);
        assertEq(g[1][1].id, 11);
        assertEq(g[1][1].data.length, 2);
        bytes32 chunk = keccak256(abi.encodePacked("grid", uint256(1), uint256(1)));
        assertEq(g[1][1].data[0], chunk[0]);
        assertEq(g[1][1].data[1], chunk[1]);
    }

    function testCubeAndNameGrid() public view {
        uint256[][][] memory cb = c.cube(3);
        assertEq(cb.length, 3);
        assertEq(cb[1].length, 2);
        assertEq(cb[1][1].length, 2);
        assertEq(cb[1][1][1], 111);
        assertEq(c.sumCube(cb), (100 + 110 + 111) + (200 + 201));
        string[][] memory ng = c.nameGrid(3);
        assertEq(ng[2].length, 2);
        assertEq(ng[2][1], "2-1");
        string[][] memory e = c.echoNameGrid(ng);
        assertEq(e[1][0], "1-0");
    }

    function testOverloads() public view {
        assertEq(c.pick(4), 5);
        assertEq(c.pick(4, 5), 20);
        assertEq(c.pick("hi"), "hi!");
    }
}
