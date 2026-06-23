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
///           * `positionsBatch(n)` — a `tuple[]` of STATIC elements (Position[]).
///           * `withBytesBatch(n)` — a `tuple[]` whose element has a DYNAMIC member (WithBytes[]).
///           * `matrix(rows)` — a ragged nested dynamic array (uint256[][]).
///           * `names(n)` — a `string[]` of varying-length strings.
///           * `sumLiquidity(Position[])` — a `tuple[]` CALL ARG (sum of a field).
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

    // ---------------------------------------------------------------- arrays of composites

    /// @notice `n` deterministic `Position` structs (a `tuple[]` with STATIC elements).
    /// @dev Element `i` is `positions(i)` reproduced inline: nonce = uint96(i),
    ///      operator = address(uint160(i * 3 + 1)), liquidity = uint128(i * 1000 + 7),
    ///      feeGrowthInside0 = keccak256(abi.encodePacked("fee0", i)),
    ///      feeGrowthInside1 = keccak256(abi.encodePacked("fee1", i)). Deterministic in `n`.
    function positionsBatch(uint256 n) external pure returns (Position[] memory) {
        Position[] memory out = new Position[](n);
        for (uint256 i = 0; i < n; i++) {
            // Truncating casts ARE the deterministic derivation (wrap into the field width).
            // forge-lint: disable-next-line(unsafe-typecast)
            uint96 nonce = uint96(i);
            // forge-lint: disable-next-line(unsafe-typecast)
            address operator = address(uint160(i * 3 + 1));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 liquidity = uint128(i * 1000 + 7);
            out[i] = Position({
                nonce: nonce,
                operator: operator,
                liquidity: liquidity,
                feeGrowthInside0: uint256(keccak256(abi.encodePacked("fee0", i))),
                feeGrowthInside1: uint256(keccak256(abi.encodePacked("fee1", i)))
            });
        }
        return out;
    }

    /// @notice `n` deterministic `WithBytes` structs (a `tuple[]` whose element has a
    ///         DYNAMIC `bytes` member — exercises offsets to dynamic tuples inside an array).
    /// @dev Element `i`: id = i + 0xC0FFEE, data = the `i`-length keccak-derived byte stream
    ///      `keccak256(abi.encodePacked("withBytes", i))[0..i]` (varying length per element).
    ///      For i >= 32 the keccak is re-seeded per 32-byte chunk (j = byte index):
    ///      data[j] = keccak256(abi.encodePacked("withBytes", i, j / 32))[j % 32]. Deterministic in `n`.
    function withBytesBatch(uint256 n) external pure returns (WithBytes[] memory) {
        WithBytes[] memory out = new WithBytes[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes memory data = new bytes(i);
            for (uint256 j = 0; j < i; j++) {
                bytes32 chunk = keccak256(abi.encodePacked("withBytes", i, j / 32));
                data[j] = chunk[j % 32];
            }
            out[i] = WithBytes({id: i + 0xC0FFEE, data: data});
        }
        return out;
    }

    /// @notice A ragged nested dynamic array `uint256[][]` (varying inner lengths exercise
    ///         per-element offsets in both the outer and inner arrays).
    /// @dev Row `r` has length `(r % 4) + 1` (so lengths cycle 1,2,3,4,1,2,3,4,…). Cell
    ///      `[r][k]` = uint256(keccak256(abi.encodePacked("matrix", r, k))). Deterministic in `rows`.
    function matrix(uint256 rows) external pure returns (uint256[][] memory) {
        uint256[][] memory out = new uint256[][](rows);
        for (uint256 r = 0; r < rows; r++) {
            uint256 len = (r % 4) + 1;
            uint256[] memory row = new uint256[](len);
            for (uint256 k = 0; k < len; k++) {
                row[k] = uint256(keccak256(abi.encodePacked("matrix", r, k)));
            }
            out[r] = row;
        }
        return out;
    }

    /// @notice `n` deterministic varying-length strings (a `string[]` — each element is a
    ///         dynamic `string`, so this exercises per-element offsets to dynamic data).
    /// @dev Element `i` is the ASCII decimal of `i` (`_toString(i)`) repeated `i + 1` times,
    ///      joined by '-' (e.g. i=0 -> "0", i=1 -> "1-1", i=2 -> "2-2-2"). Deterministic in `n`.
    function names(uint256 n) external pure returns (string[] memory) {
        string[] memory out = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory token = _toString(i);
            string memory s = token;
            for (uint256 k = 0; k < i; k++) {
                s = string.concat(s, "-", token);
            }
            out[i] = s;
        }
        return out;
    }

    /// @dev Minimal base-10 uint -> ASCII decimal string (self-contained; no library dep).
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 t = value; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            digits--;
            // forge-lint: disable-next-line(unsafe-typecast)
            buf[digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(buf);
    }

    /// @notice Sum of the `liquidity` field over a `tuple[]` calldata arg (exercises encoding
    ///         a `tuple[]` as a CALL ARGUMENT). Deterministic in the input.
    /// @dev Returns `sum(ps[i].liquidity)` as a uint256 (widened, so no overflow on the sum).
    function sumLiquidity(Position[] calldata ps) external pure returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < ps.length; i++) {
            sum += uint256(ps[i].liquidity);
        }
        return sum;
    }
}
