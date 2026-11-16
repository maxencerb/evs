// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Malformed — attacker-shaped returndata generator
/// @notice The on-anvil mirror of the evs decode-bounds unit tests (src/codegen/call.test.ts),
///         run case by case against anvil by test/integration/revert-bubbling.test.ts.
///         Every function SUCCEEDS (no revert) but hand-builds returndata via inline
///         assembly that violates the ABI shape its Solidity signature declares: wrong
///         lengths, returndata shorter than the head, absurd/huge head offsets, huge
///         lengths, off-by-one tail truncations, and non-canonical (dirty-word) values.
///         evs strict calls must revert `EvsDecodeError(site)` on every one of them, the
///         dirty-word cases included (solc's ABI decoder reverts on those too: it never
///         masks a word into range); tryCall must zero on failure.
contract Malformed {
    // ------------------------------------------------ returndata shorter than the head
    /// @dev Declared `string` but returns ZERO bytes — rds < 32 * nOutputs.
    function emptyReturn() external pure returns (string memory) {
        assembly {
            return(0, 0)
        }
    }

    /// @dev Declared `uint256` but returns only 16 bytes (all 0xff).
    function shortWord() external pure returns (uint256) {
        assembly {
            mstore(0x00, not(0))
            return(0x00, 0x10)
        }
    }

    /// @dev Declared `(uint256, uint256)` but returns a single word — head short by one slot.
    function shortHead() external pure returns (uint256, uint256) {
        assembly {
            mstore(0x00, 1)
            return(0x00, 0x20)
        }
    }

    // ------------------------------------------------ absurd head offsets
    /// @dev Declared `string`; head offset = 2**255 (fails the off <= 2**64-1 guard).
    function hugeOffset() external pure returns (string memory) {
        assembly {
            mstore(0x00, shl(255, 1))
            return(0x00, 0x20)
        }
    }

    /// @dev Declared `bytes`; head offset 0x200 points past the 32-byte returndata.
    function offsetPastEnd() external pure returns (bytes memory) {
        assembly {
            mstore(0x00, 0x200)
            return(0x00, 0x20)
        }
    }

    // ------------------------------------------------ wrong / huge lengths
    /// @dev Declared `string`; length word = 2**200 (fails the len <= 2**64-1 guard).
    function hugeLength() external pure returns (string memory) {
        assembly {
            mstore(0x00, 0x20)
            mstore(0x20, shl(200, 1))
            return(0x00, 0x40)
        }
    }

    /// @dev Declared `bytes`; length 33 but only 32 payload bytes present — off by ONE byte
    ///      (off + 32 + len = 0x61 > rds = 0x60).
    function lengthPastEndByOne() external pure returns (bytes memory) {
        assembly {
            mstore(0x00, 0x20)
            mstore(0x20, 33)
            mstore(0x40, not(0))
            return(0x00, 0x60)
        }
    }

    /// @dev Declared `uint256[]`; length 2 but only one element word present
    ///      (off + 32 + 32*len = 0x80 > rds = 0x60).
    function truncatedArray() external pure returns (uint256[] memory) {
        assembly {
            mstore(0x00, 0x20)
            mstore(0x20, 2)
            mstore(0x40, 7)
            return(0x00, 0x60)
        }
    }

    /// @dev Declared `uint256[]`; length word = 2**64 (fails the len <= 2**64-1 guard).
    function hugeArrayLength() external pure returns (uint256[] memory) {
        assembly {
            mstore(0x00, 0x20)
            mstore(0x20, shl(64, 1))
            return(0x00, 0x40)
        }
    }

    /// @dev Declared `uint256`; returns 33 bytes (longer than the head, odd tail byte).
    ///      Structurally VALID for evs (rds >= 32) — the extra byte must be ignored.
    function oneByteTooLong() external pure returns (uint256) {
        assembly {
            mstore(0x00, 42)
            mstore8(0x20, 0xff)
            return(0x00, 0x21)
        }
    }

    // ------------------------------------------------ caller-crafted returndata
    /// @dev Returns `data` VERBATIM as the returndata (no ABI wrapping). Scripts declare this
    ///      function with whatever output shape a case needs — the selector only depends on the
    ///      name and the `bytes` input — and pass the crafted payload: huge in-range length
    ///      words, nested tuples with short heads, overlapping (aliased) tails.
    function echoRaw(bytes calldata data) external pure returns (bytes memory) {
        assembly {
            calldatacopy(0, data.offset, data.length)
            return(0, data.length)
        }
    }

    // ------------------------------------------------ non-canonical word values
    /// @dev Declared `bool` but the word is 2 — out of range, a decode failure.
    function dirtyBool() external pure returns (bool) {
        assembly {
            mstore(0x00, 2)
            return(0x00, 0x20)
        }
    }

    /// @dev Declared `uint8` but every bit of the word is set — out of range, a decode failure.
    function dirtyUint8() external pure returns (uint8) {
        assembly {
            mstore(0x00, not(0))
            return(0x00, 0x20)
        }
    }

    /// @dev Declared `address` but the high 96 bits are dirty — out of range, a decode failure.
    function dirtyAddress() external pure returns (address) {
        assembly {
            mstore(0x00, not(0))
            return(0x00, 0x20)
        }
    }

    /// @dev Declared `int8`; word is 0x80 (NOT sign-extended) — canonical int8 -128 is the
    ///      all-high-bits word, so this one is out of range, a decode failure.
    function dirtyInt8() external pure returns (int8) {
        assembly {
            mstore(0x00, 0x80)
            return(0x00, 0x20)
        }
    }

    /// @dev Declared `bytes4` but the low byte of the word is set — out of range, a decode
    ///      failure (a `bytesN` is left-aligned, its low `32 - N` bytes zero).
    function dirtyBytes4() external pure returns (bytes4) {
        assembly {
            mstore(0x00, or(shl(224, 0x11223344), 1))
            return(0x00, 0x20)
        }
    }
}
