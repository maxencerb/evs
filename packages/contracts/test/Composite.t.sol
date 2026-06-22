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
}
