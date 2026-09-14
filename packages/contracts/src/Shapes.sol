// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Shapes — the remaining array/type shapes fixture for the evs type-shapes suite (issue #4)
/// @notice Every getter is `external pure` and fully deterministic, so the differential and
///         integration suites can pin exact returndata bytes against real solc. Covers:
///           * fixed-size arrays `T[N]` — word element (`uint256[2]`, `address[3]`), static
///             struct element (`Position[2]`), dynamic element (`string[2]`), and both mixed
///             nestings (`uint256[2][]`, `uint256[][2]`);
///           * two-level tuple arrays `tuple[][]` — static (`Position[][]`) and dynamic-member
///             (`WithBytes[][]`) elements;
///           * arrays nested deeper than one level — `uint256[][][]`, `string[][]`, `bytes[][]`;
///           * each shape as a CALL ARGUMENT (an echo + a reduction) and as a return;
///           * overloaded `view`/`pure` functions (`pick`) resolved by arity and by arg type.
contract Shapes {
    struct Position {
        uint96 nonce;
        address operator;
        uint128 liquidity;
    }

    struct WithBytes {
        uint256 id;
        bytes data;
    }

    // ---------------------------------------------------------------- fixed-size arrays T[N]

    /// @notice `[seed, seed * 2]`.
    function pair(uint256 seed) external pure returns (uint256[2] memory) {
        return [seed, seed * 2];
    }

    /// @notice `[address(seed + 1), address(seed + 2), address(seed + 3)]` (low 160 bits).
    function addrs3(uint256 seed) external pure returns (address[3] memory) {
        // Truncating casts ARE the deterministic derivation (wrap into the field width).
        // forge-lint: disable-next-line(unsafe-typecast)
        address a = address(uint160(seed + 1));
        // forge-lint: disable-next-line(unsafe-typecast)
        address b = address(uint160(seed + 2));
        // forge-lint: disable-next-line(unsafe-typecast)
        address c = address(uint160(seed + 3));
        return [a, b, c];
    }

    /// @notice Two deterministic positions: element `i` = `_position(seed + i)`.
    function positions2(uint256 seed) external pure returns (Position[2] memory) {
        return [_position(seed), _position(seed + 1)];
    }

    /// @notice `["<seed>", "<seed>-<seed>"]` (ASCII decimals).
    function names2(uint256 seed) external pure returns (string[2] memory) {
        string memory token = _toString(seed);
        return [token, string.concat(token, "-", token)];
    }

    /// @notice `n` pairs: row `r` = `[r, r * 10]` (a dynamic array of fixed-size arrays).
    function pairs(uint256 n) external pure returns (uint256[2][] memory) {
        uint256[2][] memory out = new uint256[2][](n);
        for (uint256 r = 0; r < n; r++) {
            out[r] = [r, r * 10];
        }
        return out;
    }

    /// @notice Two ragged columns: col 0 has `n` cells `[0..n)`, col 1 has `n + 1` cells `[100..100+n]`
    ///         (a fixed-size array of dynamic arrays).
    function cols(uint256 n) external pure returns (uint256[][2] memory) {
        uint256[][2] memory out;
        out[0] = new uint256[](n);
        out[1] = new uint256[](n + 1);
        for (uint256 i = 0; i < n; i++) out[0][i] = i;
        for (uint256 i = 0; i <= n; i++) out[1][i] = 100 + i;
        return out;
    }

    /// @notice Identity echo of a `uint256[2]` CALL ARG.
    function echoPair(uint256[2] calldata p) external pure returns (uint256[2] memory) {
        return p;
    }

    /// @notice `p[0] + p[1]` — a `uint256[2]` CALL ARG reduced to a word.
    function sumPair(uint256[2] calldata p) external pure returns (uint256) {
        return p[0] + p[1];
    }

    /// @notice Identity echo of a `string[2]` CALL ARG (a dynamic-element fixed array).
    function echoNames2(string[2] calldata ns) external pure returns (string[2] memory) {
        return ns;
    }

    /// @notice Sum over every cell of a `uint256[2][]` CALL ARG.
    function sumPairs(uint256[2][] calldata ps) external pure returns (uint256) {
        uint256 sum = 0;
        for (uint256 r = 0; r < ps.length; r++) sum += ps[r][0] + ps[r][1];
        return sum;
    }

    // ---------------------------------------------------------------- tuple[][]

    /// @notice `rows` rows; row `r` has `(r % 3) + 1` positions, cell `[r][k]` = `_position(r * 10 + k)`.
    function positionsGrid(uint256 rows) external pure returns (Position[][] memory) {
        Position[][] memory out = new Position[][](rows);
        for (uint256 r = 0; r < rows; r++) {
            uint256 len = (r % 3) + 1;
            Position[] memory row = new Position[](len);
            for (uint256 k = 0; k < len; k++) row[k] = _position(r * 10 + k);
            out[r] = row;
        }
        return out;
    }

    /// @notice `rows` rows; row `r` has `(r % 2) + 1` elements, cell `[r][k]` has id `r * 10 + k`
    ///         and data = the `(r + k) % 5`-byte stream `keccak256(abi.encodePacked("grid", r, k))[0..len)`.
    function withBytesGrid(uint256 rows) external pure returns (WithBytes[][] memory) {
        WithBytes[][] memory out = new WithBytes[][](rows);
        for (uint256 r = 0; r < rows; r++) {
            uint256 len = (r % 2) + 1;
            WithBytes[] memory row = new WithBytes[](len);
            for (uint256 k = 0; k < len; k++) {
                uint256 dlen = (r + k) % 5;
                bytes memory data = new bytes(dlen);
                bytes32 chunk = keccak256(abi.encodePacked("grid", r, k));
                for (uint256 j = 0; j < dlen; j++) data[j] = chunk[j];
                row[k] = WithBytes({id: r * 10 + k, data: data});
            }
            out[r] = row;
        }
        return out;
    }

    /// @notice Sum of `liquidity` over every cell of a `Position[][]` CALL ARG.
    function sumGridLiquidity(Position[][] calldata grid) external pure returns (uint256) {
        uint256 sum = 0;
        for (uint256 r = 0; r < grid.length; r++) {
            for (uint256 k = 0; k < grid[r].length; k++) sum += uint256(grid[r][k].liquidity);
        }
        return sum;
    }

    /// @notice Identity echo of a `Position[][]` CALL ARG.
    function echoGrid(Position[][] calldata grid) external pure returns (Position[][] memory) {
        return grid;
    }

    // ---------------------------------------------------------------- deeper nesting

    /// @notice `n` slabs; slab `s` has `(s % 2) + 1` rows; row `[s][r]` has `(s + r) % 3` cells;
    ///         cell `[s][r][k]` = `s * 100 + r * 10 + k`.
    function cube(uint256 n) external pure returns (uint256[][][] memory) {
        uint256[][][] memory out = new uint256[][][](n);
        for (uint256 s = 0; s < n; s++) {
            uint256 rows = (s % 2) + 1;
            uint256[][] memory slab = new uint256[][](rows);
            for (uint256 r = 0; r < rows; r++) {
                uint256 len = (s + r) % 3;
                uint256[] memory row = new uint256[](len);
                for (uint256 k = 0; k < len; k++) row[k] = s * 100 + r * 10 + k;
                slab[r] = row;
            }
            out[s] = slab;
        }
        return out;
    }

    /// @notice `n` rows; row `r` has `(r % 3)` names, cell `[r][k]` = `"<r>-<k>"`.
    function nameGrid(uint256 n) external pure returns (string[][] memory) {
        string[][] memory out = new string[][](n);
        for (uint256 r = 0; r < n; r++) {
            uint256 len = r % 3;
            string[] memory row = new string[](len);
            for (uint256 k = 0; k < len; k++) row[k] = string.concat(_toString(r), "-", _toString(k));
            out[r] = row;
        }
        return out;
    }

    /// @notice Sum over every cell of a `uint256[][][]` CALL ARG.
    function sumCube(uint256[][][] calldata c) external pure returns (uint256) {
        uint256 sum = 0;
        for (uint256 s = 0; s < c.length; s++) {
            for (uint256 r = 0; r < c[s].length; r++) {
                for (uint256 k = 0; k < c[s][r].length; k++) sum += c[s][r][k];
            }
        }
        return sum;
    }

    /// @notice Identity echo of a `string[][]` CALL ARG.
    function echoNameGrid(string[][] calldata g) external pure returns (string[][] memory) {
        return g;
    }

    // ---------------------------------------------------------------- overloads

    /// @notice `pick(x)` → `x + 1`.
    function pick(uint256 x) external pure returns (uint256) {
        return x + 1;
    }

    /// @notice `pick(x, y)` → `x * y` (same name, arity 2).
    function pick(uint256 x, uint256 y) external pure returns (uint256) {
        return x * y;
    }

    /// @notice `pick(s)` → `"<s>!"` (same name and arity as `pick(uint256)`, a different type).
    function pick(string calldata s) external pure returns (string memory) {
        return string.concat(s, "!");
    }

    // ---------------------------------------------------------------- helpers

    /// @dev nonce = uint96(i), operator = address(uint160(i * 3 + 1)), liquidity = uint128(i * 1000 + 7).
    function _position(uint256 i) internal pure returns (Position memory) {
        // Truncating casts ARE the deterministic derivation (wrap into the field width).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 nonce = uint96(i);
        // forge-lint: disable-next-line(unsafe-typecast)
        address operator = address(uint160(i * 3 + 1));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidity = uint128(i * 1000 + 7);
        return Position({nonce: nonce, operator: operator, liquidity: liquidity});
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
}
