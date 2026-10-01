---
'@maxencerb/evs': minor
---

New builder reads for account state: `s.balance(address)` (the native balance in wei, `BALANCE`), `s.codeSize(address)` (`EXTCODESIZE`) and `s.codeHash(address)` (`EXTCODEHASH`, zero for an account that does not exist). They take an `Expr<'address'>` or an address literal and return `Expr<'uint256'>` / `Expr<'uint256'>` / `Expr<'bytes32'>`, so a native balance no longer needs a Multicall3 `getEthBalance` call and a script can tell an EOA from a contract. `s.balance(s.env('address'))`, the script's own balance, compiles to `SELFBALANCE` and gets an `ENV_FRAME_DEPENDENT` warning, because it differs between the deployless and state-override modes. `interpret()` answers these reads from a new optional `MockChain.account(address)` oracle (`{ balance, code, nonce }`, or `undefined` for no account); without it every address reads as nonexistent. The serialized IR gains an `account` statement (`balance` / `codesize` / `codehash`).
