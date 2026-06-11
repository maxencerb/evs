// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockUniV3Pool — Uniswap V3 pool fixture for the evs flagship scenario
/// @notice Exposes the read surface the api.md E1 `poolMeta` script consumes:
///         token0() / token1() / fee() / tickSpacing() / liquidity() and the
///         seven-output slot0() getter, signature-identical to IUniswapV3Pool.
///         slot0 values and liquidity are configurable via the set* test helpers.
contract MockUniV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    uint128 public liquidity;

    uint160 private _sqrtPriceX96;
    int24 private _tick;
    uint16 private _observationIndex;
    uint16 private _observationCardinality;
    uint16 private _observationCardinalityNext;
    uint8 private _feeProtocol;
    bool private _unlocked;

    constructor(address token0_, address token1_, uint24 fee_, int24 tickSpacing_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        _unlocked = true;
    }

    /// @notice Mirrors IUniswapV3Pool.slot0() — seven word-typed outputs.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (
            _sqrtPriceX96,
            _tick,
            _observationIndex,
            _observationCardinality,
            _observationCardinalityNext,
            _feeProtocol,
            _unlocked
        );
    }

    /// @notice Test helper — configure every slot0 component.
    function setSlot0(
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    ) external {
        _sqrtPriceX96 = sqrtPriceX96;
        _tick = tick;
        _observationIndex = observationIndex;
        _observationCardinality = observationCardinality;
        _observationCardinalityNext = observationCardinalityNext;
        _feeProtocol = feeProtocol;
        _unlocked = unlocked;
    }

    /// @notice Test helper.
    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }
}
