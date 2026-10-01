// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title EvsFullMathReference — solc oracle for wrapping arithmetic and mulDiv
/// @notice The ground truth for evs `wrappingAdd` / `wrappingSub` / `wrappingMul` (solc's
///         `unchecked { … }` blocks, per width class) and `mulDiv` / `mulDivRoundingUp` (the
///         FullMath 512-bit algorithm with OpenZeppelin `Math.mulDiv`'s Panic codes: 0x12 on a
///         zero denominator, 0x11 when the quotient does not fit uint256), asserted by
///         test/integration/full-math.test.ts: identical results and byte-identical Panic
///         payloads.
contract EvsFullMathReference {
    // ---------------------------------------------------------------- unchecked add / sub / mul
    function wrapAddU8(uint8 a, uint8 b) external pure returns (uint8) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubU8(uint8 a, uint8 b) external pure returns (uint8) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulU8(uint8 a, uint8 b) external pure returns (uint8) {
        unchecked {
            return a * b;
        }
    }

    function wrapAddU192(uint192 a, uint192 b) external pure returns (uint192) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubU192(uint192 a, uint192 b) external pure returns (uint192) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulU192(uint192 a, uint192 b) external pure returns (uint192) {
        unchecked {
            return a * b;
        }
    }

    function wrapAddU256(uint256 a, uint256 b) external pure returns (uint256) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubU256(uint256 a, uint256 b) external pure returns (uint256) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulU256(uint256 a, uint256 b) external pure returns (uint256) {
        unchecked {
            return a * b;
        }
    }

    function wrapAddI8(int8 a, int8 b) external pure returns (int8) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubI8(int8 a, int8 b) external pure returns (int8) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulI8(int8 a, int8 b) external pure returns (int8) {
        unchecked {
            return a * b;
        }
    }

    function wrapAddI200(int200 a, int200 b) external pure returns (int200) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubI200(int200 a, int200 b) external pure returns (int200) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulI200(int200 a, int200 b) external pure returns (int200) {
        unchecked {
            return a * b;
        }
    }

    function wrapAddI256(int256 a, int256 b) external pure returns (int256) {
        unchecked {
            return a + b;
        }
    }

    function wrapSubI256(int256 a, int256 b) external pure returns (int256) {
        unchecked {
            return a - b;
        }
    }

    function wrapMulI256(int256 a, int256 b) external pure returns (int256) {
        unchecked {
            return a * b;
        }
    }

    // ---------------------------------------------------------------- mulDiv
    /// @dev ⌊x·y / d⌋ over a 512-bit intermediate (Remco Bloemen's FullMath, as in Uniswap v3
    ///      and OpenZeppelin `Math.mulDiv`).
    function mulDiv(uint256 x, uint256 y, uint256 d) public pure returns (uint256 result) {
        unchecked {
            uint256 prod0 = x * y;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                // checked division: Panic 0x12 when d == 0 (the unchecked block does not change it)
                return prod0 / d;
            }
            if (d <= prod1) _panic(d == 0 ? 0x12 : 0x11);

            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (0 - d);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * d) ^ 2;
            inverse *= 2 - d * inverse; // 8 bits
            inverse *= 2 - d * inverse; // 16 bits
            inverse *= 2 - d * inverse; // 32 bits
            inverse *= 2 - d * inverse; // 64 bits
            inverse *= 2 - d * inverse; // 128 bits
            inverse *= 2 - d * inverse; // 256 bits
            result = prod0 * inverse;
        }
    }

    /// @dev ⌈x·y / d⌉: the floor plus one when inexact, the increment checked (Panic 0x11).
    function mulDivRoundingUp(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        uint256 result = mulDiv(x, y, d);
        if (mulmod(x, y, d) > 0) result += 1;
        return result;
    }

    function _panic(uint256 code) private pure {
        assembly {
            mstore(0x00, 0x4e487b71)
            mstore(0x20, code)
            revert(0x1c, 0x24)
        }
    }
}
