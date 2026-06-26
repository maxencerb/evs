// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockQuoter — a Uniswap-style quoter fixture for the issue #1 `s.call` surface
/// @notice Quoter functions are NONPAYABLE (not `view`) even though they only compute a quote: they
///         simulate a swap and touch storage, so the EVM forbids them under STATICCALL. They are
///         the canonical case for `s.call` (a real CALL frame for a non-view function that does not
///         usefully persist state). `quoteExactInput` returns the amount out normally (QuoterV2
///         style); `quoteExactInputReverting` reverts with the ABI-encoded result (QuoterV1 style),
///         exercised through `s.tryCall` — decoding revert-data-as-result is a documented v0
///         follow-up.
contract MockQuoter {
    uint256 private _nonce; // written so the quote legitimately needs a non-static frame

    /// @notice QuoterV2 style: returns `amountIn * 3 / 2` (a 1.5x mock quote). NONPAYABLE.
    function quoteExactInput(uint256 amountIn) external returns (uint256 amountOut) {
        _nonce++;
        amountOut = (amountIn * 3) / 2;
    }

    /// @notice QuoterV1 style: reverts with the ABI-encoded amount out. NONPAYABLE.
    function quoteExactInputReverting(uint256 amountIn) external {
        _nonce++; // a real reverting quoter performs the (rolled-back) swap before reverting
        uint256 amountOut = (amountIn * 3) / 2;
        bytes memory data = abi.encode(amountOut);
        assembly {
            revert(add(data, 0x20), mload(data))
        }
    }
}
