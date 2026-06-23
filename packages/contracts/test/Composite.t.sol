// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Composite} from "../src/Composite.sol";

/// @notice Pins the exact shape/values every Composite getter returns, so the evs
///         differential and integration suites can assume them. Each assertion mirrors
///         the deterministic derivation in Composite.sol field-for-field.
contract CompositeTest is Test {
    Composite internal c;

    function setUp() public {
        c = new Composite();
    }

    function testPositionsDerivation() public view {
        uint256 tokenId = 123456;
        Composite.Position memory p = c.positions(tokenId);
        // These wraps mirror Composite.positions field-for-field (see that fn's casts).
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(p.nonce, uint96(tokenId));
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(p.operator, address(uint160(tokenId * 3 + 1)));
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(p.liquidity, uint128(tokenId * 1000 + 7));
        assertEq(
            p.feeGrowthInside0,
            uint256(keccak256(abi.encodePacked("fee0", tokenId)))
        );
        assertEq(
            p.feeGrowthInside1,
            uint256(keccak256(abi.encodePacked("fee1", tokenId)))
        );
    }

    function testPositionsZero() public view {
        Composite.Position memory p = c.positions(0);
        assertEq(p.nonce, 0);
        assertEq(p.operator, address(uint160(1)));
        assertEq(p.liquidity, 7);
        assertEq(p.feeGrowthInside0, uint256(keccak256(abi.encodePacked("fee0", uint256(0)))));
        assertEq(p.feeGrowthInside1, uint256(keccak256(abi.encodePacked("fee1", uint256(0)))));
    }

    function testSlot0Struct() public view {
        Composite.Slot0 memory s = c.slot0Struct();
        assertEq(s.sqrtPriceX96, 79228162514264337593543950336);
        assertEq(s.tick, -887272);
        assertEq(s.observationIndex, 3);
        assertEq(s.feeProtocol, 4);
        assertTrue(s.unlocked);
    }

    function testGetOuterNested() public view {
        Composite.Outer memory o = c.getOuter();
        assertTrue(o.inner.a);
        assertEq(o.inner.b, keccak256("evs.composite.outer.inner"));
        assertEq(o.x, 0xDEADBEEF);
    }

    function testQuoteDerivation() public view {
        Composite.QuoteParams memory params = Composite.QuoteParams({
            tokenIn: address(0xAAAA),
            tokenOut: address(0xBBBB),
            fee: 3000,
            amountIn: 1_000_000 ether
        });
        (uint256 amountOut, Composite.Position memory pos) = c.quote(params);

        uint256 expectedOut = (params.amountIn * uint256(params.fee)) / 1e6;
        assertEq(amountOut, expectedOut);

        uint256 seed = uint256(
            keccak256(abi.encode(params.tokenIn, params.tokenOut, params.fee, params.amountIn))
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(pos.nonce, uint96(seed));
        assertEq(pos.operator, params.tokenIn);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(pos.liquidity, uint128(expectedOut));
        assertEq(pos.feeGrowthInside0, seed);
        assertEq(pos.feeGrowthInside1, uint256(params.fee));
    }

    function testEchoStructIdentity() public view {
        Composite.Position memory p = Composite.Position({
            nonce: 42,
            operator: address(0xCAFE),
            liquidity: 9999,
            feeGrowthInside0: 0x1234,
            feeGrowthInside1: 0x5678
        });
        Composite.Position memory out = c.echoStruct(p);
        assertEq(out.nonce, p.nonce);
        assertEq(out.operator, p.operator);
        assertEq(out.liquidity, p.liquidity);
        assertEq(out.feeGrowthInside0, p.feeGrowthInside0);
        assertEq(out.feeGrowthInside1, p.feeGrowthInside1);
    }

    function testGetWithBytesDynamicMember() public view {
        Composite.WithBytes memory w = c.getWithBytes();
        assertEq(w.id, 0xC0FFEE);
        assertEq(w.data, hex"6576732100");
        assertEq(w.data.length, 5);
    }

    // ---------------------------------------------------------------- arrays of composites

    function testPositionsBatchStaticElements() public view {
        uint256 n = 4;
        Composite.Position[] memory ps = c.positionsBatch(n);
        assertEq(ps.length, n);
        for (uint256 i = 0; i < n; i++) {
            // Mirrors Composite.positionsBatch element-derivation field-for-field.
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(ps[i].nonce, uint96(i));
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(ps[i].operator, address(uint160(i * 3 + 1)));
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(ps[i].liquidity, uint128(i * 1000 + 7));
            assertEq(ps[i].feeGrowthInside0, uint256(keccak256(abi.encodePacked("fee0", i))));
            assertEq(ps[i].feeGrowthInside1, uint256(keccak256(abi.encodePacked("fee1", i))));
        }
    }

    function testPositionsBatchEmpty() public view {
        Composite.Position[] memory ps = c.positionsBatch(0);
        assertEq(ps.length, 0);
    }

    function testWithBytesBatchDynamicElements() public view {
        uint256 n = 35; // crosses the 32-byte keccak-chunk boundary (i = 32..34)
        Composite.WithBytes[] memory ws = c.withBytesBatch(n);
        assertEq(ws.length, n);
        for (uint256 i = 0; i < n; i++) {
            assertEq(ws[i].id, i + 0xC0FFEE);
            assertEq(ws[i].data.length, i);
            for (uint256 j = 0; j < i; j++) {
                bytes32 chunk = keccak256(abi.encodePacked("withBytes", i, j / 32));
                assertEq(ws[i].data[j], chunk[j % 32]);
            }
        }
    }

    function testMatrixRagged() public view {
        uint256 rows = 10;
        uint256[][] memory m = c.matrix(rows);
        assertEq(m.length, rows);
        for (uint256 r = 0; r < rows; r++) {
            uint256 len = (r % 4) + 1;
            assertEq(m[r].length, len);
            for (uint256 k = 0; k < len; k++) {
                assertEq(m[r][k], uint256(keccak256(abi.encodePacked("matrix", r, k))));
            }
        }
    }

    function testMatrixEmpty() public view {
        uint256[][] memory m = c.matrix(0);
        assertEq(m.length, 0);
    }

    function testNamesVaryingLength() public view {
        uint256 n = 12; // crosses single->double digit (i = 10, 11) so token width varies
        string[] memory ns = c.names(n);
        assertEq(ns.length, n);
        for (uint256 i = 0; i < n; i++) {
            string memory token = vm.toString(i);
            string memory expected = token;
            for (uint256 k = 0; k < i; k++) {
                expected = string.concat(expected, "-", token);
            }
            assertEq(ns[i], expected);
        }
        // Spot-check the documented examples.
        assertEq(ns[0], "0");
        assertEq(ns[1], "1-1");
        assertEq(ns[2], "2-2-2");
        assertEq(ns[11], "11-11-11-11-11-11-11-11-11-11-11-11");
    }

    function testSumLiquidityTupleArrayArg() public view {
        // Build a tuple[] arg and encode it as calldata via the external call.
        uint256 n = 5;
        Composite.Position[] memory ps = c.positionsBatch(n);
        uint256 expected = 0;
        for (uint256 i = 0; i < n; i++) {
            expected += uint256(ps[i].liquidity);
        }
        assertEq(c.sumLiquidity(ps), expected);
    }

    function testSumLiquidityEmpty() public view {
        Composite.Position[] memory ps = new Composite.Position[](0);
        assertEq(c.sumLiquidity(ps), 0);
    }
}
