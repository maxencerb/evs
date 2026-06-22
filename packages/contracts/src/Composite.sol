// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Composite — struct/tuple read fixture for the evs composite-types suite (issue #2)
/// @notice Every getter is `external pure` and fully deterministic (no state, no env reads), so
///         the differential and integration suites can pin exact returndata bytes. The struct
///         surface mirrors real-world ABIs the builder targets:
///           * `positions(tokenId)` — a five-field static struct, signature-identical to
///             Uniswap V3 INonfungiblePositionManager.positions (truncated to the fields evs
///             exercises) with fields derived deterministically from `tokenId`.
///           * `slot0Struct()` — a five-field static struct, the IUniswapV3Pool.slot0 shape
///             packed into a named struct (vs the seven-output tuple in MockUniV3Pool).
///           * `getOuter()` — a NESTED static struct (Outer { Inner; uint256 }).
///           * `quote(QuoteParams)` — a composite INPUT plus a (uint256, Position) composite
///             OUTPUT, outputs derived deterministically from the input.
///           * `echoStruct(Position)` — an identity echo (composite in, same composite out).
///           * `getWithBytes()` — a struct with a DYNAMIC `bytes` member (dynamic tuple tail).
contract Composite {
    // ---------------------------------------------------------------- Position (static struct)
    /// @dev Mirrors Uniswap V3 INonfungiblePositionManager.positions return shape (subset).
    struct Position {
        uint96 nonce;
        address operator;
        uint128 liquidity;
        uint256 feeGrowthInside0;
        uint256 feeGrowthInside1;
    }

    /// @dev Mirrors IUniswapV3Pool.slot0() as a named struct (vs the seven-output tuple).
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint16 observationIndex;
        uint8 feeProtocol;
        bool unlocked;
    }

    // ---------------------------------------------------------------- nested struct
    struct Inner {
        bool a;
        bytes32 b;
    }

    struct Outer {
        Inner inner;
        uint256 x;
    }

    // ---------------------------------------------------------------- struct-taking view fn
    struct QuoteParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
    }

    // ---------------------------------------------------------------- dynamic-member struct
    struct WithBytes {
        uint256 id;
        bytes data;
    }

    /// @notice Deterministic Position derived from `tokenId` (mirrors a positions() getter).
    /// @dev nonce = tokenId (mod 2**96), operator = address(uint160(tokenId * 3 + 1)),
    ///      liquidity = tokenId * 1000 + 7 (mod 2**128),
    ///      feeGrowthInside0 = keccak256("fee0", tokenId), feeGrowthInside1 = keccak256("fee1", tokenId).
    function positions(uint256 tokenId) external pure returns (Position memory) {
        // The truncating casts ARE the deterministic derivation (wrap into the field width).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 nonce = uint96(tokenId);
        // forge-lint: disable-next-line(unsafe-typecast)
        address operator = address(uint160(tokenId * 3 + 1));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidity = uint128(tokenId * 1000 + 7);
        return Position({
            nonce: nonce,
            operator: operator,
            liquidity: liquidity,
            feeGrowthInside0: uint256(keccak256(abi.encodePacked("fee0", tokenId))),
            feeGrowthInside1: uint256(keccak256(abi.encodePacked("fee1", tokenId)))
        });
    }

    /// @notice A fixed, fully-static `Slot0` struct (deterministic constants).
    function slot0Struct() external pure returns (Slot0 memory) {
        return Slot0({
            sqrtPriceX96: 79228162514264337593543950336, // 2**96 (price == 1.0)
            tick: -887272, // MIN_TICK
            observationIndex: 3,
            feeProtocol: 4,
            unlocked: true
        });
    }

    /// @notice A nested struct with deterministic constant fields.
    function getOuter() external pure returns (Outer memory) {
        return Outer({
            inner: Inner({a: true, b: keccak256("evs.composite.outer.inner")}),
            x: 0xDEADBEEF
        });
    }

    /// @notice Composite INPUT and a (uint256, Position) composite OUTPUT, both deterministic.
    /// @dev amountOut = amountIn * fee / 1e6 (the canonical Uniswap "amount after fee" shape),
    ///      pos derived from the keccak of the encoded params (so every input field matters).
    function quote(QuoteParams calldata p)
        external
        pure
        returns (uint256 amountOut, Position memory pos)
    {
        amountOut = (p.amountIn * uint256(p.fee)) / 1e6;
        uint256 seed = uint256(
            keccak256(abi.encode(p.tokenIn, p.tokenOut, p.fee, p.amountIn))
        );
        // Truncating casts ARE the deterministic derivation (wrap into the field width).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 nonce = uint96(seed);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidity = uint128(amountOut);
        pos = Position({
            nonce: nonce,
            operator: p.tokenIn,
            liquidity: liquidity,
            feeGrowthInside0: seed,
            feeGrowthInside1: uint256(p.fee)
        });
    }

    /// @notice Identity echo — composite in, the same composite out.
    function echoStruct(Position calldata p) external pure returns (Position memory) {
        return p;
    }

    /// @notice A struct with a dynamic `bytes` member (exercises a dynamic tuple tail).
    /// @dev id = 0xC0FFEE, data = the 5 bytes "evs!" + 0x00 sentinel, deterministic.
    function getWithBytes() external pure returns (WithBytes memory) {
        return WithBytes({id: 0xC0FFEE, data: hex"6576732100"});
    }
}
