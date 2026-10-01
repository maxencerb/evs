// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title EvsCastReference — solc oracle for address / fixed-bytes conversions and byte access
/// @notice The ground truth for evs `lt`/`gt`/`lte`/`gte` on `address` and `bytesN`,
///         `asUint160` / `asAddress` from `uint160`, the same-width `asUint` / `asBytesN`,
///         `string` ↔ `bytes`, `byteAt`, `slice` and `bytesN` → `string`, asserted by
///         test/integration/casts.test.ts: equal decoded results, and byte-identical Panic
///         payloads where solc panics (`b[i]` out of range is `Panic(0x32)` in both).
///         A calldata slice out of range reverts without data in solc; evs reverts with
///         `Panic(0x32)` there (the test checks both revert). Solidity has no
///         `bytes32 → string`: `bytes32ToString` is the hand-written loop legacy-token readers
///         use (trailing zero bytes dropped), which `asString()` replaces.
contract EvsCastReference {
    // ------------------------------------------------------------------------------- ordering
    function orderAddress(address a, address b) external pure returns (bool, bool, bool, bool) {
        return (a < b, a <= b, a > b, a >= b);
    }

    function orderBytes4(bytes4 a, bytes4 b) external pure returns (bool, bool, bool, bool) {
        return (a < b, a <= b, a > b, a >= b);
    }

    function orderBytes32(bytes32 a, bytes32 b) external pure returns (bool, bool, bool, bool) {
        return (a < b, a <= b, a > b, a >= b);
    }

    function sortTokens(address a, address b) external pure returns (address token0, address token1) {
        return a < b ? (a, b) : (b, a);
    }

    // -------------------------------------------------------------------- address <-> uint160
    function addressToUint160(address a) external pure returns (uint160) {
        return uint160(a);
    }

    function addressToUint256(address a) external pure returns (uint256) {
        return uint256(uint160(a));
    }

    function uint160ToAddress(uint160 u) external pure returns (address) {
        return address(u);
    }

    // ------------------------------------------------------------- same-width bytesN <-> uintN
    function bytes1ToUint8(bytes1 b) external pure returns (uint8) {
        return uint8(b);
    }

    function bytes4ToUint32(bytes4 b) external pure returns (uint32) {
        return uint32(b);
    }

    function bytes20ToUint160(bytes20 b) external pure returns (uint160) {
        return uint160(b);
    }

    function bytes32ToUint256(bytes32 b) external pure returns (uint256) {
        return uint256(b);
    }

    function uint8ToBytes1(uint8 u) external pure returns (bytes1) {
        return bytes1(u);
    }

    function uint32ToBytes4(uint32 u) external pure returns (bytes4) {
        return bytes4(u);
    }

    function uint160ToBytes20(uint160 u) external pure returns (bytes20) {
        return bytes20(u);
    }

    function uint256ToBytes32(uint256 u) external pure returns (bytes32) {
        return bytes32(u);
    }

    // ------------------------------------------------------------- string / bytes byte access
    function byteAtBytes(bytes memory b, uint256 i) external pure returns (bytes1) {
        return b[i];
    }

    function byteAtString(string memory s, uint256 i) external pure returns (bytes1) {
        return bytes(s)[i];
    }

    function sliceBytes(bytes calldata b, uint256 start, uint256 end) external pure returns (bytes memory) {
        return b[start:end];
    }

    function sliceBytesFrom(bytes calldata b, uint256 start) external pure returns (bytes memory) {
        return b[start:];
    }

    function sliceString(string calldata s, uint256 start, uint256 end) external pure returns (string memory) {
        return string(bytes(s)[start:end]);
    }

    function stringToBytes(string memory s) external pure returns (bytes memory) {
        return bytes(s);
    }

    function bytesToString(bytes memory b) external pure returns (string memory) {
        return string(b);
    }

    // ------------------------------------------------------------------ bytesN -> string (trim)
    function bytes32ToString(bytes32 x) external pure returns (string memory) {
        return _trimmed(x, 32);
    }

    function bytes4ToString(bytes4 x) external pure returns (string memory) {
        return _trimmed(bytes32(x), 4);
    }

    function _trimmed(bytes32 x, uint256 size) private pure returns (string memory) {
        uint256 n = size;
        while (n > 0 && x[n - 1] == 0) n--;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = x[i];
        }
        return string(out);
    }
}
