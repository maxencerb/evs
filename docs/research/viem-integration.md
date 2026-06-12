# viem execution surface for non-deployed bytecode (evs research)

Research date: **2026-06-11**. viem version verified against: **2.52.2** (latest on npm at research time).
All "empirically verified" claims below were run in this session against **anvil 1.7.1** (`anvil --fork-url https://ethereum-rpc.publicnode.com`, mainnet fork) with **viem@2.52.2** under Bun 1.3.14, and typechecked with `tsc --strict` (exit 0).

---

## TL;DR — decisions that matter for evs

1. **viem's deployless `code` parameter expects CREATION (init) bytecode, NOT runtime bytecode.** viem wraps it in a constructor that runs `create2(0, add(bytecode, 0x20), mload(bytecode), 0)` — CREATE2 executes its argument as init code. The evs compiler emits runtime bytecode, so `toViem()` must prepend an init-code stub for deployless mode (11-byte universal prefix `0x600b5981380380925939f3`).
2. **Passing runtime bytecode to `code` fails SILENTLY** (empirically verified): the runtime is executed as init code, its `RETURN` data becomes the "deployed code", and the subsequent call returns empty data — no revert, no error. This is the #1 footgun to guard against.
3. `stateOverride` mode takes **runtime bytecode directly** and gives a deterministic `address(this)`. It is supported by anvil (source-verified), geth (documented), QuickNode (documented), publicnode (empirically verified), but is **not documented** on Alchemy's or Infura's `eth_call` reference pages — deployless mode is the maximally portable default because it is a plain 2-parameter `eth_call` with `to: null`.
4. Minimum viem versions: `stateOverride` on `call`/`readContract`/`simulateContract`/`multicall` since **2.7.3**; `factory`/`factoryData` since **2.14.0**; `code` since **2.14.1**; `simulateCalls` since **2.23.0**. → set `peerDependencies: { "viem": ">=2.14.1" }` (or `>=2.23.0` if you ship `simulateCalls` helpers).
5. The script can **STATICCALL real deployed contracts in both modes** (empirically verified against forked mainnet WETH).
6. Recommended `toViem()` shapes (both spread directly into `readContract` and typecheck): deployless → `{ abi, code: initPrefix + runtime }`; override → `{ abi, address, stateOverride: [{ address, code: runtime }] }`.

---

## 1. Deployless Calls in viem

Docs: <https://viem.sh/docs/actions/public/call> (sections "Deployless Calls" → "Bytecode" and "Deploy Factory") and <https://viem.sh/docs/contract/readContract> ("Deployless Reads").

### 1.1 Parameters (exact names and types)

From `src/actions/public/call.ts` (<https://github.com/wevm/viem/blob/main/src/actions/public/call.ts>):

```ts
/** Bytecode to perform the call on. */
code?: Hex | undefined
/** Contract deployment factory address (ie. Create2 factory, Smart Account factory, etc). */
factory?: Address | undefined
/** Calldata to execute on the factory to deploy the contract. */
factoryData?: Hex | undefined
```

Validation logic in `call.ts` (quoted from main as of 2026-06-11):

```ts
if (code && (factory || factoryData))
  throw new BaseError('Cannot provide both `code` & `factory`/`factoryData` as parameters.');
if (code && to) throw new BaseError('Cannot provide both `code` & `to` as parameters.');

// Check if the call is deployless via bytecode.
const deploylessCallViaBytecode = code && data_;
// Check if the call is deployless via a factory.
const deploylessCallViaFactory = factory && factoryData && to && data_;
const deploylessCall = deploylessCallViaBytecode || deploylessCallViaFactory;
```

When a deployless call is detected, viem sends `eth_call` with **`to: undefined`** (i.e. JSON `to` omitted → contract-creation call frame) and `data` set to the deploy-data of a wrapper contract (see 1.3). So:

- **`code` mode**: provide `code` + `data` (calldata); MUST NOT provide `to`.
- **`factory` mode**: provide `factory` + `factoryData` + `to` (the counterfactual address) + `data`.
- Both modes also exist on `readContract` (which builds `data` from `abi`/`functionName`/`args` and forwards everything to `call`), and on the contract-instance API (`getContract`).

### 1.2 Minimum versions (from `src/CHANGELOG.md`, <https://github.com/wevm/viem/blob/main/src/CHANGELOG.md>)

| Feature                                                                                    | viem version | PR                                                                       |
| ------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------ |
| `stateOverride` on `call`, `simulateContract`, `readContract`, `multicall`                 | **2.7.3**    | [#1759](https://github.com/wevm/viem/pull/1759) (authored by @maxencerb) |
| `stateOverride` on `estimateGas`                                                           | **2.10.11**  | [#2275](https://github.com/wevm/viem/pull/2275)                          |
| `factory` & `factoryData` on `call` & `readContract` (Deployless Calls via Factory)        | **2.14.0**   | [#2405](https://github.com/wevm/viem/pull/2405)                          |
| `code` on `call` & `readContract` (Deployless Calls via Bytecode)                          | **2.14.1**   | [#2408](https://github.com/wevm/viem/pull/2408)                          |
| Exported `deploylessCallViaBytecodeBytecode`, `deploylessCallViaFactoryBytecode` constants | **2.19.2**   | commit `d22855b`                                                         |
| `simulateCalls` action (uses `eth_simulateV1`)                                             | **2.23.0**   | [#3326](https://github.com/wevm/viem/pull/3326)                          |
| `deployless` parameter on `multicall` (deployless-injects Multicall3 on chains lacking it) | **2.36.0**   | [#3883](https://github.com/wevm/viem/pull/3883)                          |
| Request batching for calls sharing matching `stateOverride`                                | **2.50.0**   | [#4337](https://github.com/wevm/viem/pull/4337)                          |

### 1.3 How viem wraps it — `code` is CREATION bytecode (the critical fact)

viem encodes the deployless call as the **deploy data of a wrapper contract** whose constructor does all the work and `RETURN`s the call result from inside the constructor (the `eth_call` result of a creation frame is whatever the init code returns). From `src/actions/public/call.ts`:

```ts
function toDeploylessCallViaBytecodeData(parameters: { code: Hex; data: Hex }) {
  const { code, data } = parameters;
  return encodeDeployData({
    abi: parseAbi(['constructor(bytes, bytes)']),
    bytecode: deploylessCallViaBytecodeBytecode,
    args: [code, data],
  });
}

function toDeploylessCallViaFactoryData(parameters: {
  data: Hex;
  factory: Address;
  factoryData: Hex;
  to: Address;
}) {
  const { data, factory, factoryData, to } = parameters;
  return encodeDeployData({
    abi: parseAbi(['constructor(address, bytes, address, bytes)']),
    bytecode: deploylessCallViaFactoryBytecode,
    args: [to, data, factory, factoryData],
  });
}
```

The wrapper bytecode constants live in `src/constants/contracts.ts` (<https://github.com/wevm/viem/blob/main/src/constants/contracts.ts>), exported since viem 2.19.2. Their Solidity sources are in the viem repo:

**`contracts/src/deployless/DeploylessCallViaBytecode.sol`** (<https://github.com/wevm/viem/blob/main/contracts/src/deployless/DeploylessCallViaBytecode.sol>), quoted verbatim:

```solidity
pragma solidity ^0.8.17;
// SPDX-License-Identifier: UNLICENSED

contract DeploylessCallViaBytecode {
    constructor(bytes memory bytecode, bytes memory data) {
        address to;
        assembly {
            to := create2(0, add(bytecode, 0x20), mload(bytecode), 0)
            if iszero(extcodesize(to)) { revert(0, 0) }
        }
        assembly {
            let success := call(gas(), to, 0, add(data, 0x20), mload(data), 0, 0)
            let ptr := mload(0x40)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(success) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }
}
```

Consequences (each empirically verified, see §3 and Appendix A):

- `create2(...)` executes `bytecode` as **init code** → **`code` must be creation bytecode**. (Note: some third-party summaries — and even a quick read of the viem docs page, which links the Etherscan `#code` view — are ambiguous; the Etherscan code page shows "Contract Creation Code", and the source above is definitive.)
- If you pass **runtime** bytecode, it executes as init code: e.g. a runtime ending in `RETURN(0, 32)` "deploys" its own return value as 32 bytes of code; the subsequent `call` to it executes byte `0x00` (STOP) and returns **empty data with no error**. Silent failure.
- The wrapper invokes the script via **`call` (not `staticcall`)** — the script need not be STATICCALL-clean itself; any state it writes is ephemeral to the `eth_call`.
- `salt = 0` in the CREATE2; revert with empty data if the deployed code is empty.
- EIP-3860 limits the inner CREATE2 init code to 49,152 bytes and EIP-170 limits the resulting script runtime to 24,576 bytes (Shanghai+ rules apply inside the simulated frame).

**`contracts/src/deployless/DeploylessCallViaFactory.sol`** (<https://github.com/wevm/viem/blob/main/contracts/src/deployless/DeploylessCallViaFactory.sol>), quoted verbatim — this is the ERC-4337-style counterfactual pattern referencing <https://eips.ethereum.org/EIPS/eip-7679>:

```solidity
pragma solidity ^0.8.17;
// SPDX-License-Identifier: UNLICENSED
// https://eips.ethereum.org/EIPS/eip-7679#counterfactual-call-contract

contract DeploylessCallViaFactory {
    error CounterfactualDeployFailed(bytes error);
    constructor(address to, bytes memory data, address factory, bytes memory factoryData) {
        if (address(to).code.length == 0) {
            (bool success, bytes memory ret) = factory.call(factoryData);
            if (!success || address(to).code.length == 0) revert CounterfactualDeployFailed(ret);
        }
        assembly {
            let success := call(gas(), to, 0, add(data, 0x20), mload(data), 0, 0)
            let ptr := mload(0x40)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(success) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }
}
```

viem detects the `CounterfactualDeployFailed` revert by checking returned data for selector `0x101bb98d` and throws `CounterfactualDeploymentFailedError` (`call.ts`). The factory variant is designed for smart accounts (deploy-then-call at a known counterfactual address); it is **not** the right fit for evs — evs has no on-chain factory. It would only become relevant if evs ever published a CREATE2 deployer for compiled scripts.

### 1.4 Default block tag

Current `call.ts` on main: `blockTag = client.experimental_blockTag ?? 'latest'` — i.e. `latest` unless the client opts into an experimental tag. (viem 2.30.2 briefly changed defaults to `pending` for `call`/`estimateGas`; current main is back to `latest` via the `experimental_blockTag` escape hatch.) `blockNumber: bigint` / `blockTag: BlockTag` are accepted by `call` and `readContract` and pass straight through as `eth_call`'s second parameter.

---

## 2. `stateOverride` in viem

### 2.1 Exact TypeScript shape

From `src/types/stateOverride.ts` (<https://github.com/wevm/viem/blob/main/src/types/stateOverride.ts>):

```ts
type StateMapping = Array<{ slot: Hex; value: Hex }>; // slot & value MUST be 32-byte hex

type StateOverride = Array<
  {
    address: Address;
    balance?: bigint | undefined;
    nonce?: number | undefined;
    code?: Hex | undefined;
  } & OneOf<
    | { /** Overrides ALL slots in the account storage */ state?: StateMapping | undefined }
    | {
        /** Overrides INDIVIDUAL slots in the account storage */ stateDiff?:
          | StateMapping
          | undefined;
      }
  >
>;
```

**It is an ARRAY of per-address objects, not an address-keyed record.** viem serializes it to the RPC address-keyed map via `serializeStateOverride` in `src/utils/stateOverride.ts` (<https://github.com/wevm/viem/blob/main/src/utils/stateOverride.ts>): `balance` → hex quantity, `nonce` → hex quantity, `state`/`stateDiff` arrays → `{ [slot]: value }` objects. It throws `AccountStateConflictError` on duplicate addresses and `StateAssignmentConflictError` if both `state` and `stateDiff` are set for one address. The serialized object is sent as the **third** `eth_call` parameter.

The wire-level (geth) object — see <https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects> ("State Override Set"):

| field                     | type     | description (geth docs, verbatim)                                                                           |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `balance`                 | Quantity | "Fake balance to set for the account before executing the call."                                            |
| `nonce`                   | Quantity | "Fake nonce to set for the account before executing the call."                                              |
| `code`                    | Binary   | "Fake EVM bytecode to inject into the account before executing the call."                                   |
| `state`                   | Object   | "Fake key-value mapping to override **all** slots in the account storage before executing the call."        |
| `stateDiff`               | Object   | "Fake key-value mapping to override **individual** slots in the account storage before executing the call." |
| `movePrecompileToAddress` | address  | "Moves precompile to given address" (geth extra; **not** in viem's type)                                    |

### 2.2 Which viem actions accept it

| Action                                | param name                                                                 | since   |
| ------------------------------------- | -------------------------------------------------------------------------- | ------- |
| `call`                                | `stateOverride`                                                            | 2.7.3   |
| `readContract`                        | `stateOverride`                                                            | 2.7.3   |
| `simulateContract`                    | `stateOverride`                                                            | 2.7.3   |
| `multicall`                           | `stateOverride`                                                            | 2.7.3   |
| `estimateGas` / `estimateContractGas` | `stateOverride`                                                            | 2.10.11 |
| `simulateCalls`                       | **`stateOverrides`** (plural!) — top-level, applies to the simulated block | 2.23.0  |
| `simulateBlocks`                      | `stateOverrides` per block entry (`blocks: [{ calls, stateOverrides }]`)   | 2.23.0  |

`simulateCalls` / `simulateBlocks` use the `eth_simulateV1` JSON-RPC method (<https://viem.sh/docs/actions/public/simulateCalls>) and serialize each block's `stateOverrides` with the same `serializeStateOverride` (verified in `src/actions/public/simulateBlocks.ts`). Note the plural/singular discrepancy: `stateOverride` everywhere except `stateOverrides` on the simulate actions.

`stateOverride` composes with deployless `code` on the same `call`/`readContract` — empirically verified (§3, test 10): a deployless script STATICCALLing WETH saw WETH's code overridden by a `stateOverride` entry in the same request.

---

## 3. Which mode for a compiled evs read-script — empirical results

Test harness: anvil 1.7.1 forking mainnet, viem 2.52.2. Bytecode fixtures were hand-assembled (Appendix A). `RUNTIME_42` returns `uint256(42)`; `RUNTIME_STATICCALL` STATICCALLs `WETH.symbol()` (real mainnet WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) and bubbles the returndata; `RUNTIME_WHOAMI` returns `(address(this), msg.sender)`.

| #   | Test                                                                       | Result                                                                                                                            |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `call({ code: INIT_PREFIX+RUNTIME_42, data: '0x' })`                       | `0x…2a` (42) — **works**                                                                                                          |
| 2   | `call({ code: RUNTIME_42, data: '0x' })` (runtime passed raw)              | `data: undefined` — **silent empty result, NO error**                                                                             |
| 3   | `call({ to, data, stateOverride: [{ address: to, code: RUNTIME_42 }] })`   | 42 — **works**                                                                                                                    |
| 4   | Deployless script STATICCALLs mainnet `WETH.symbol()`                      | `"WETH"` — **works**                                                                                                              |
| 5   | State-override script STATICCALLs mainnet `WETH.symbol()`                  | `"WETH"` — **works**                                                                                                              |
| 6   | Deployless `address(this)` / `msg.sender`                                  | `this = 0x135C88a859246c0Bb974b75e47A8675873AE750A` (varies with bytecode), `sender = 0xBd770416a3345F91E4B34576cb804a576fa48EB1` |
| 7   | State-override `address(this)` / `msg.sender`                              | `this =` the chosen override address, `sender = 0x0000000000000000000000000000000000000000` (no `account` passed)                 |
| 8   | `readContract({ abi, code, functionName })` (no `address`)                 | 42, fully typed — **works, typechecks**                                                                                           |
| 9   | `readContract({ abi, address, functionName, stateOverride })`              | 42 — **works, typechecks**                                                                                                        |
| 10  | Deployless `code` + `stateOverride` overriding WETH's code in same request | override visible to the script — **composes**                                                                                     |

### 3.1 Identity semantics per mode

**Deployless (`code`) mode** — the call stack is: `eth_call` creation frame (wrapper) → `CREATE2` (script constructor) → `CALL` (script body) → script's own `STATICCALL`s.

- Wrapper address = ordinary CREATE address of `(from, nonce(from))`. With no `account`, `from` is the zero address (nonce 0 on mainnet) → wrapper = **`0xBd770416a3345F91E4B34576cb804a576fa48EB1`** (constant in practice; changes if the caller passes `account` or if the zero address's nonce ever differed on some chain).
- Script `address(this)` = `CREATE2(wrapper, salt = bytes32(0), keccak256(scriptCreationCode))` — **deterministic but different for every compiled script**. Verified: `getContractAddress({ opcode: 'CREATE2', from: wrapper, salt: '0x' + '00'.repeat(32), bytecode: creationCode })` reproduced the observed `0x135C88a…750A` exactly.
- `msg.sender` inside the script = wrapper address. `tx.origin` = `from`. Contracts the script STATICCALLs see `msg.sender` = the script's CREATE2 address.
- The script also runs its constructor (the init prefix) — harmless for evs's stub.

**State-override mode** — plain `eth_call` to a chosen address whose code is replaced.

- `address(this)` = the address you chose. Pick an address with no mainnet state: overriding `code` does **not** clear the account's existing balance/nonce/storage, so injecting at e.g. WETH's address would leave WETH's storage visible to the script via `SLOAD`. evs scripts shouldn't read their own storage, but choose a vanity constant anyway (suggestion below).
- `msg.sender` = `account` parameter, defaulting to the zero address. Fully controllable — useful if a target contract gates reads on `msg.sender`.

### 3.2 Recommendation

**Default to deployless (`code`) mode**: it is a plain two-parameter `eth_call` (`to` omitted), so it works on every node/provider that implements standard `eth_call`, including providers that do not support the state-override third parameter. Offer state-override mode as an option for (a) a stable, human-meaningful `address(this)`, (b) custom `msg.sender`, (c) composing with additional overrides (token balance spoofing etc.), and (d) environments where the ~53 bytes/element ABI-encoding overhead of the wrapper matters (negligible).

Both modes share the node's `eth_call` gas cap (geth default `--rpc.gascap` 50,000,000; providers vary) — relevant ceiling for scripts making many STATICCALLs.

---

## 4. Support matrix: `eth_call` state overrides & deployless pattern

| Backend                        | `eth_call` 3rd-param state override                                                                                                                                                                                                                                                                              | deployless (`eth_call`, `to` omitted)                                                     | `eth_simulateV1`                                                      | Evidence                                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **geth**                       | Yes — documented, fields `balance/nonce/code/state/stateDiff/movePrecompileToAddress` (+ 4th param block overrides)                                                                                                                                                                                              | Yes (standard creation-frame `eth_call`)                                                  | Yes (live on mainnet from geth **v1.14.9**)                           | <https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth-call>, <https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set>                                                             |
| **anvil (foundry)**            | Yes — `EthRequest::EthCall(call, block, state_override, block_overrides)`; also on `eth_estimateGas`                                                                                                                                                                                                             | Yes (empirically verified this session, v1.7.1, incl. forking mode)                       | Yes — `EthRequest::EthSimulateV1` implemented                         | source: `crates/anvil/src/eth/api.rs` <https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/api.rs> (lines ~1599–1610, ~2406); empirical tests §3                                                           |
| **QuickNode**                  | Yes — documented third "Object" param with `balance`, `nonce`, `code`, `state`, `stateDiff`                                                                                                                                                                                                                      | Yes (standard `eth_call`)                                                                 | per-chain                                                             | <https://www.quicknode.com/docs/ethereum/eth_call>                                                                                                                                                                            |
| **Alchemy**                    | **Not documented** — eth_call reference lists only 2 params (Transaction, Block). Alchemy does document state-override types for simulation tooling and supports overrides on `debug_traceCall`/`eth_callMany`. Live test from this session was inconclusive (demo key → HTTP 429). Treat as "probe at runtime". | Yes (standard `eth_call`)                                                                 | Yes — documented                                                      | <https://www.alchemy.com/docs/reference/eth-call>, <https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-simulate-v-1>, <https://www.alchemy.com/docs/node/debug-api/debug-api-endpoints/debug-trace-call> |
| **Infura (MetaMask Services)** | **Not documented** — eth_call page lists only transaction object + block parameter                                                                                                                                                                                                                               | Yes (standard `eth_call`)                                                                 | Yes — documented with `stateOverrides` (balance/state/stateDiff etc.) | <https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_call/>, <https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_simulatev1/>                                                    |
| **publicnode** (free)          | Yes — empirically verified this session (code override returned expected value)                                                                                                                                                                                                                                  | Yes — empirically verified (`to: null` init-code execution returned its `RETURN` payload) | untested                                                              | raw curl transcripts, Appendix B                                                                                                                                                                                              |

Practical reading: **deployless mode works everywhere `eth_call` works**. State-override mode is safe on self-hosted geth-likes, anvil, QuickNode and publicnode; on Alchemy/Infura it is undocumented for `eth_call` (it may pass through to the underlying client, but don't build the default path on it). evs tests on anvil exercise both modes faithfully.

---

## 5. Recommended `script.toViem()` shapes

### 5.0 The init-code prefix (deployless mode needs it)

The evs compiler emits **runtime** bytecode. For deployless mode, wrap it in the 11-byte universal constructor that copies everything after itself and returns it as the runtime code (length-agnostic, no placeholders):

```
0x600B5981380380925939F3
opcode  stack after (top → left)
600B    PUSH1 0x0B        [0x0B]
59      MSIZE             [0, 0x0B]                       ; MSIZE == 0 here
81      DUP2              [0x0B, 0, 0x0B]
38      CODESIZE          [CS, 0x0B, 0, 0x0B]
03      SUB               [CS-0x0B, 0, 0x0B]              ; = runtime length L
80      DUP1              [L, L, 0, 0x0B]
92      SWAP3             [0x0B, L, 0, L]
59      MSIZE             [0, 0x0B, L, 0, L]
39      CODECOPY          [0, L]                          ; mem[0..L] = code[0x0B..]
F3      RETURN                                            ; return mem[0..L]
```

Equivalent explicit-length variant (12 bytes): `0x61{len:2-byte BE}80600C6000396000F3`. Empirically verified: `0x600b5981380380925939f3 + runtime` deploys and behaves identically to the runtime (tests 1, 4, 6).

### 5.1 Helper implementation

```ts
import type { Abi, Address, Hex, StateOverride } from 'viem';

/** 11-byte universal constructor: returns everything after itself as runtime code. */
export const INIT_CODE_PREFIX = '0x600b5981380380925939f3' as const;

/** Default script address for state-override mode: last 20 bytes of keccak256("evs.script").
 *  No code/storage/balance on any major chain; replaceable per call. */
export const DEFAULT_SCRIPT_ADDRESS = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530' as const;

export function toCreationBytecode(runtime: Hex): Hex {
  return `${INIT_CODE_PREFIX}${runtime.slice(2)}` as Hex;
}

// (a) deployless mode — maximum RPC compatibility
export function toViemDeployless<const abi extends Abi>(s: { abi: abi; runtime: Hex }) {
  return { abi: s.abi, code: toCreationBytecode(s.runtime) } as const;
}

// (b) state-override mode — deterministic address(this), controllable msg.sender
export function toViemStateOverride<const abi extends Abi>(
  s: { abi: abi; runtime: Hex },
  opts?: { address?: Address },
) {
  const address = opts?.address ?? DEFAULT_SCRIPT_ADDRESS;
  return {
    abi: s.abi,
    address,
    stateOverride: [{ address, code: s.runtime }] satisfies StateOverride,
  } as const;
}
```

### 5.2 Consumption (all variants typecheck against viem 2.52.2, `tsc --strict`)

```ts
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

// (a) deployless — readContract infers the return tuple from the literal abi
const out = await client.readContract({
  ...script.toViem(), // { abi, code }  — NOTE: no `address` allowed
  functionName: 'main', // evs entrypoint in the generated abi
  args: [poolAddress],
  // blockNumber: 22_000_000n,           // optional; defaults to 'latest'
});

// (b) state-override
const out2 = await client.readContract({
  ...script.toViem({ mode: 'stateOverride' }), // { abi, address, stateOverride }
  functionName: 'main',
  args: [poolAddress],
  // account: '0x…',                     // optional: controls msg.sender seen by the script
});

// (b') raw call + manual decode, if callers bypass readContract
import { decodeFunctionResult, encodeFunctionData } from 'viem';
const { data } = await client.call({
  to: DEFAULT_SCRIPT_ADDRESS,
  data: encodeFunctionData({ abi: script.abi, functionName: 'main', args: [poolAddress] }),
  stateOverride: [{ address: DEFAULT_SCRIPT_ADDRESS, code: script.runtime }],
});
const decoded = decodeFunctionResult({ abi: script.abi, functionName: 'main', data: data! });

// batching several scripts in one request (viem >= 2.23.0, needs eth_simulateV1):
const { results } = await client.simulateCalls({
  calls: [
    { to: addrA, data: callDataA },
    { to: addrB, data: callDataB },
  ],
  stateOverrides: [
    // plural! top-level
    { address: addrA, code: scriptA.runtime },
    { address: addrB, code: scriptB.runtime },
  ],
});
```

### 5.3 API design notes

- Make `toViem()` (no args) return the **deployless** shape — it works on any provider. `toViem({ mode: 'stateOverride', address? })` returns shape (b).
- Both returned objects are designed to be **spread into `readContract`** so viem's literal-ABI inference does all the typing; evs's generated `as const` ABI is the other half of that contract.
- **Guard the footgun**: never expose raw runtime bytecode under a key named `code`. If users grab `script.bytecode`, document which flavor it is; consider naming fields `runtimeBytecode` and `creationBytecode` explicitly.
- If the script ever needs to know its own deployless address ahead of time (it shouldn't for pure reads): wrapper = `getContractAddress({ from: account ?? zeroAddress, nonce: nonceOf(from) })` (= `0xBd770416a3345F91E4B34576cb804a576fa48EB1` for the default), script = `getContractAddress({ opcode: 'CREATE2', from: wrapper, salt: '0x' + '00'.repeat(32), bytecode: creationBytecode })`. This derivation reproduced the observed address exactly.
- peerDependency: `"viem": ">=2.14.1"` (deployless `code` + `stateOverride` on readContract); `>=2.23.0` if shipping `simulateCalls` batching helpers.
- Keep compiled runtime ≤ 24,576 bytes (EIP-170) so deployless mode always works; creation bytecode (runtime + 11) stays far below the 49,152-byte EIP-3860 init-code cap.

---

## Appendix A — bytecode fixtures used in the empirical tests

```
RUNTIME_42        = 0x602a60005260206000f3
                    PUSH1 0x2a PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN     ; returns uint256(42)

RUNTIME_WHOAMI    = 0x306000523360205260406000f3
                    ADDRESS PUSH1 0 MSTORE CALLER PUSH1 0x20 MSTORE
                    PUSH1 0x40 PUSH1 0 RETURN                               ; returns (address(this), msg.sender)

RUNTIME_STATICCALL (calls WETH.symbol() and bubbles returndata):
  6395d89b41 60e0 1b 6000 52        ; mstore(0, selector("symbol()") << 224)
  6000 6000 6004 6000               ; retLen=0 retOff=0 argLen=4 argOff=0
  73 c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
  5a fa 50                          ; staticcall(gas, WETH, 0, 4, 0, 0); pop
  3d 6000 6000 3e                   ; returndatacopy(0, 0, returndatasize)
  3d 6000 f3                        ; return(0, returndatasize)

creation(x) = 0x600b5981380380925939f3 ++ x
```

Observed: test 2 (`code: RUNTIME_42`) — the wrapper CREATE2 "succeeded" (the runtime's `RETURN(0,32)` acted as the init-code return, deploying `0x00…2a` as 32 bytes of code), the inner call executed STOP, and viem returned `{ data: undefined }`. **No exception was thrown.**

## Appendix B — raw RPC probes (publicnode, 2026-06-11)

```jsonc
// state override code injection — supported
>> {"method":"eth_call","params":[
     {"to":"0x1111111111111111111111111111111111111111","data":"0x"},
     "latest",
     {"0x1111111111111111111111111111111111111111":{"code":"0x602a60005260206000f3"}}]}
<< {"result":"0x000000000000000000000000000000000000000000000000000000000000002a"}

// to omitted → data executed as init code; eth_call returns the init code's RETURN payload
>> {"method":"eth_call","params":[{"data":"0x69602a60005260206000f3600052600a6016f3"},"latest"]}
<< {"result":"0x602a60005260206000f3"}
```

(Alchemy demo endpoint returned HTTP 429 — rate limited, not a method rejection; llamarpc returned HTTP 521 — origin down.)

## Source index

- viem deployless docs: <https://viem.sh/docs/actions/public/call>, <https://viem.sh/docs/contract/readContract>
- viem simulateCalls docs: <https://viem.sh/docs/actions/public/simulateCalls>
- viem source: <https://github.com/wevm/viem/blob/main/src/actions/public/call.ts>, <https://github.com/wevm/viem/blob/main/src/types/stateOverride.ts>, <https://github.com/wevm/viem/blob/main/src/utils/stateOverride.ts>, <https://github.com/wevm/viem/blob/main/src/constants/contracts.ts>, <https://github.com/wevm/viem/blob/main/src/CHANGELOG.md>
- viem wrapper contracts: <https://github.com/wevm/viem/blob/main/contracts/src/deployless/DeploylessCallViaBytecode.sol>, <https://github.com/wevm/viem/blob/main/contracts/src/deployless/DeploylessCallViaFactory.sol>
- EIP-7679 counterfactual call contract: <https://eips.ethereum.org/EIPS/eip-7679>
- geth: <https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth-call>, <https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects#state-override-set>
- anvil source: <https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/api.rs>
- QuickNode: <https://www.quicknode.com/docs/ethereum/eth_call>
- Alchemy: <https://www.alchemy.com/docs/reference/eth-call>, <https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-simulate-v-1>
- Infura/MetaMask: <https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_call/>, <https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_simulatev1/>
