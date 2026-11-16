// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev A static struct with one member of every narrow word family.
struct Rec {
    address owner;
    uint8 kind;
    bool live;
    int24 tick;
    bytes2 tag;
    uint256 n;
}

/// @dev A dynamic struct: a narrow word next to a tail.
struct Named {
    uint8 kind;
    string name;
}

// `Malformed.echoRaw(bytes)` returns its argument verbatim as the returndata. Each interface
// below declares that one selector with a different return type, so a high-level call through
// it runs solc's ABI decoder for that type over bytes the caller chose.

interface IEchoWords {
    function echoRaw(bytes calldata data) external view returns (bool, address, uint8, int8, bytes4);
}

interface IEchoRec {
    function echoRaw(bytes calldata data) external view returns (Rec memory);
}

interface IEchoNamed {
    function echoRaw(bytes calldata data) external view returns (Named memory);
}

interface IEchoKinds {
    function echoRaw(bytes calldata data) external view returns (uint8[] memory);
}

interface IEchoTicks {
    function echoRaw(bytes calldata data) external view returns (int16[3] memory);
}

interface IEchoRecs {
    function echoRaw(bytes calldata data) external view returns (Rec[] memory);
}

interface IEchoGrid {
    function echoRaw(bytes calldata data) external view returns (bool[][] memory);
}

interface INoOutputs {
    function check(uint256 x) external view;
}

/// @title StrictDecodeReference — what a Solidity caller makes of the same bytes
/// @notice The solc side of the evs strict-decoding tests. evs refuses a word that is out of
///         range for its ABI type, and a call through a function without outputs to an address
///         without code, "as solc does": this contract is that claim, executable. Each function
///         decodes with solc 0.8.30's own ABI decoder what an evs script decodes in the same
///         test, so a case where one accepts and the other refuses fails the test.
contract StrictDecodeReference {
    // ---------------------------------------------------------------- returndata of a call

    function words(address target, bytes calldata data)
        external
        view
        returns (bool, address, uint8, int8, bytes4)
    {
        return IEchoWords(target).echoRaw(data);
    }

    function rec(address target, bytes calldata data) external view returns (Rec memory) {
        return IEchoRec(target).echoRaw(data);
    }

    function named(address target, bytes calldata data) external view returns (Named memory) {
        return IEchoNamed(target).echoRaw(data);
    }

    function kinds(address target, bytes calldata data) external view returns (uint8[] memory) {
        return IEchoKinds(target).echoRaw(data);
    }

    function ticks(address target, bytes calldata data) external view returns (int16[3] memory) {
        return IEchoTicks(target).echoRaw(data);
    }

    function recs(address target, bytes calldata data) external view returns (Rec[] memory) {
        return IEchoRecs(target).echoRaw(data);
    }

    function grid(address target, bytes calldata data) external view returns (bool[][] memory) {
        return IEchoGrid(target).echoRaw(data);
    }

    // ---------------------------------------------------------------- the function's own arguments
    // `memory` parameters: solc decodes and validates them on entry, as evs decodes a script's
    // arguments (a `calldata` parameter is only validated where the body reads it).

    function argWords(bool a, address b, uint8 c, int8 d, bytes4 e)
        external
        pure
        returns (bool, address, uint8, int8, bytes4)
    {
        return (a, b, c, d, e);
    }

    function argRec(Rec memory r) external pure returns (Rec memory) {
        return r;
    }

    function argNamed(Named memory r) external pure returns (Named memory) {
        return r;
    }

    function argKinds(uint8[] memory xs) external pure returns (uint8[] memory) {
        return xs;
    }

    function argTicks(int16[3] memory xs) external pure returns (int16[3] memory) {
        return xs;
    }

    function argRecs(Rec[] memory xs) external pure returns (Rec[] memory) {
        return xs;
    }

    function argGrid(bool[][] memory xs) external pure returns (bool[][] memory) {
        return xs;
    }

    // ---------------------------------------------------------------- a function without outputs

    /// @dev Nothing is decoded, so solc checks `extcodesize(target)` before the call and reverts
    ///      when it is zero.
    function check(address target, uint256 x) external view {
        INoOutputs(target).check(x);
    }
}
