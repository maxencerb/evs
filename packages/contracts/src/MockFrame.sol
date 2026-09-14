// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockFrame — a fixture that OBSERVES the call frame evs hands its targets (issue #36)
/// @notice Two things a script's sub-call target can see and a test wants to pin:
///         - `msg.sender`: `whoCalls` (NONPAYABLE — it writes `lastCaller`, so it runs under
///           s.call / s.simulate) and `caller` (view, for s.read) both return it. In the default
///           execution modes that is the script's own address; in sender mode
///           (`toViem({ mode: 'stateOverride', sender })`) it is the chosen sender.
///         - gas: `gasProbe` (NONPAYABLE) / `gasProbeView` (view) return `gasleft()` on entry, so
///           a site's `gas` cap is observable as an upper bound on the value read back; `burnAll`
///           loops until it runs out of gas — the misbehaving target a `gas` cap must contain.
contract MockFrame {
    address public lastCaller;
    uint256 private _nonce;

    /// @notice Returns msg.sender. NONPAYABLE (touches storage) — the s.call / s.simulate target.
    function whoCalls() external returns (address) {
        lastCaller = msg.sender;
        return msg.sender;
    }

    /// @notice Returns msg.sender. View — the s.read target.
    function caller() external view returns (address) {
        return msg.sender;
    }

    /// @notice Returns `gasleft()` on entry. NONPAYABLE — observes a s.call / s.simulate gas cap.
    function gasProbe() external returns (uint256 g) {
        g = gasleft();
        _nonce++;
    }

    /// @notice Returns `gasleft()` on entry. View — observes a s.read gas cap.
    function gasProbeView() external view returns (uint256) {
        return gasleft();
    }

    /// @notice Burns every unit of gas it is given (never returns). NONPAYABLE.
    function burnAll() external {
        while (true) {
            _nonce++;
        }
    }
}
