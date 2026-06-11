# EVM codegen target facts for the `evs` compiler

Research date: 2026-06-11. All claims verified against current docs/specs on this date.
Audience: implementers of the evs IR -> EVM bytecode compiler (no web access assumed).

---

## 1. Target hardfork choice

### What mainnet runs (as of June 2026)

- **Fusaka** (consensus-layer name **Fulu** + execution-layer name **Osaka**) activated on
  Ethereum mainnet on **2025-12-03 at 21:49:11 UTC (epoch 411392)**.
  Sources: https://blog.ethereum.org/2025/11/06/fusaka-mainnet-announcement ,
  https://ethereum.org/roadmap/fusaka/
- Fusaka's EVM-relevant EIPs:
  - **EIP-7939 `CLZ`** — new opcode `0x1E`, count leading zeros, gas 5, `CLZ(0) = 256`.
    https://eips.ethereum.org/EIPS/eip-7939
  - **EIP-7825** — protocol-level **transaction gas cap of 16,777,216 (2^24)** gas per
    transaction. This applies to real transactions only — `eth_call` is not a transaction, so
    read scripts can exceed it via RPC. Implication: any read workload needing >16.7M gas can
    *only* run via `eth_call`, which is exactly our execution model.
    https://eips.ethereum.org/EIPS/eip-7825 ,
    https://blog.ethereum.org/2025/10/21/fusaka-gascap-update
  - Block gas limit: Fusaka roadmap targets **60M** block gas (raised from 45M during 2025).
    https://www.coingecko.com/learn/what-is-ethereum-fusaka-upgrade
  - **EIP-7907 (code size limit increase) was NOT included** — deferred to Glamsterdam, so
    EIP-170's 24,576-byte limit is still in force.
- **Next fork: Glamsterdam** (Gloas + Amsterdam), expected later in 2026; headliners are ePBS
  and block-level access lists — not shipped as of 2026-06-11. Mainnet today = **Osaka EL rules**.
  https://ethereum.org/roadmap/fusaka/

### EOF status — emit legacy bytecode

- **EOF (EVM Object Format) was removed from Fusaka** on the All Core Devs call of
  **2025-04-28** (timeline risk + technical uncertainty around the "Option D" variant). It is
  *deferred*, with Glamsterdam as the earliest possible re-entry, and has **not** been scheduled.
  Sources: https://thedefiant.io/news/blockchains/ethereum-removes-evm-object-format-fusaka-upgrade-eyes-glamsterdam-b97edac0 ,
  https://blockworks.co/news/ethereum-consensus-evm-upgrade-fusaka-devs ,
  https://cryptoslate.com/ethereum-drops-eof-from-fusaka-upgrade-after-community-pushback/
- **Conclusion: emit classic legacy bytecode** (flat opcode stream, JUMPDEST-validated jumps,
  no EOF containers/sections). Even if EOF ships eventually, legacy code remains valid.

### Anvil (test runner) defaults

- Latest stable Foundry: **v1.7.1, released 2026-05-08**
  (https://github.com/foundry-rs/foundry/releases).
- `anvil --hardfork` defaults to **`latest`**
  (https://getfoundry.sh/anvil/reference/anvil/). Since Foundry **v1.6.0**, the default EVM
  version was bumped from `prague` to **`osaka`**
  (https://github.com/foundry-rs/foundry/issues/12730), so anvil 1.7.x runs Osaka by default.
  Pin tests explicitly with `anvil --hardfork <fork>` if determinism across foundry upgrades
  matters.

### Recommended opcode floor

**Default target: Cancun** — i.e. assume:

- `PUSH0` (`0x5F`) — EIP-3855, **Shanghai** (mainnet April 2023)
- `MCOPY` (`0x5E`) — EIP-5656, **Cancun** (mainnet March 2024)
- Everything older (SHL/SHR/SAR from Constantinople; RETURNDATASIZE/RETURNDATACOPY, REVERT,
  STATICCALL from Byzantium) is universally available.

Rationale: mainnet and every major L2 have been on Cancun-equivalent rules for >2 years.
**Make it configurable** as a compiler option, e.g.
`target: "paris" | "shanghai" | "cancun"` (default `"cancun"`):

- `paris`/pre-Shanghai: lower `PUSH0` to `PUSH1 0x00` (or `RETURNDATASIZE` before any call has
  been made — it is guaranteed 0 then and is 1 byte / 2 gas).
- pre-Cancun: lower `MCOPY` to a word-by-word `MLOAD`/`MSTORE` loop.
- Do **not** emit Osaka-only `CLZ` (`0x1E`) by default; offer it only behind
  `target: "osaka"` if ever needed. Do not emit `TSTORE`/`TLOAD` at all: scripts must remain
  callable inside `STATICCALL`, and `TSTORE` causes an exceptional halt in a static context.

---

## 2. Opcode reference (everything evs emits)

Conventions (matching https://www.evm.codes/ and its data at
https://github.com/smlxl/evm.codes `opcodes.json`):

- **Stack-in is listed top-of-stack first.** `a, b` means `a` is popped first (it was on top).
- All arithmetic is mod 2^256 unless noted. Signed ops use two's complement.
- "memexp" = memory expansion cost (Section 4 formula).
- Gas values are Berlin/EIP-2929+ (unchanged through Osaka).
- Stack limit is 1024 items; overflow/underflow = exceptional halt (all forwarded gas consumed).

| Op | Hex | Stack in (top first) | Stack out | Gas | Semantics / notes |
|---|---|---|---|---|---|
| STOP | 0x00 | — | — | 0 | Halt, success, empty return data. |
| ADD | 0x01 | `a, b` | `a + b` | 3 | Wrapping. |
| MUL | 0x02 | `a, b` | `a * b` | 5 | Wrapping. |
| SUB | 0x03 | `a, b` | `a - b` | 3 | Wrapping (top minus second). |
| DIV | 0x04 | `a, b` | `a // b` | 5 | Unsigned. **Returns 0 if `b == 0`** (no trap). |
| SDIV | 0x05 | `a, b` | `a // b` signed | 5 | 0 if `b == 0`. **`-2^255 / -1` wraps to `-2^255`** (no trap). Truncates toward zero. |
| MOD | 0x06 | `a, b` | `a % b` | 5 | Unsigned. 0 if `b == 0`. |
| SMOD | 0x07 | `a, b` | `a % b` signed | 5 | 0 if `b == 0`. Result takes the **sign of the dividend `a`**. |
| ADDMOD | 0x08 | `a, b, N` | `(a + b) % N` | 8 | Intermediate sum is NOT truncated to 256 bits. 0 if `N == 0`. |
| MULMOD | 0x09 | `a, b, N` | `(a * b) % N` | 8 | Full-precision product. 0 if `N == 0`. |
| EXP | 0x0A | `a, exponent` | `a ** exponent` | 10 + 50·byteLen(exponent) | byteLen = minimal bytes to represent exponent (EIP-160). |
| SIGNEXTEND | 0x0B | `b, x` | `signextend(x)` | 5 | Sign-extends `x` from `(b+1)*8` bits; `b` is the index of the sign byte (0 = extend from 8 bits). `b >= 31` is identity. |
| LT | 0x10 | `a, b` | `a < b ? 1 : 0` | 3 | Unsigned. |
| GT | 0x11 | `a, b` | `a > b ? 1 : 0` | 3 | Unsigned. |
| SLT | 0x12 | `a, b` | `a < b ? 1 : 0` | 3 | Signed. |
| SGT | 0x13 | `a, b` | `a > b ? 1 : 0` | 3 | Signed. |
| EQ | 0x14 | `a, b` | `a == b ? 1 : 0` | 3 | |
| ISZERO | 0x15 | `a` | `a == 0 ? 1 : 0` | 3 | Also used as logical NOT on booleans. |
| AND | 0x16 | `a, b` | `a & b` | 3 | |
| OR | 0x17 | `a, b` | `a \| b` | 3 | |
| XOR | 0x18 | `a, b` | `a ^ b` | 3 | |
| NOT | 0x19 | `a` | `~a` | 3 | Bitwise, not logical. |
| BYTE | 0x1A | `i, x` | byte `i` of `x` | 3 | **`i` counts from the most significant byte** (`i = 0` -> MSB, `i = 31` -> LSB). Returns 0 for `i >= 32`. |
| SHL | 0x1B | `shift, value` | `value << shift` | 3 | 0 if `shift >= 256`. Constantinople (EIP-145). |
| SHR | 0x1C | `shift, value` | `value >> shift` (logical) | 3 | 0 if `shift >= 256`. |
| SAR | 0x1D | `shift, value` | `value >> shift` (arithmetic) | 3 | Sign-fills. If `shift >= 256`: result is 0 (non-negative) or all-ones (negative). |
| KECCAK256 | 0x20 | `offset, size` | `hash` | 30 + 6·⌈size/32⌉ + memexp | Hash of `mem[offset .. offset+size)`. |
| ADDRESS | 0x30 | — | `address(this)` | 2 | The executing account (the override address, or the counterfactual address in deployless mode). |
| CALLER | 0x33 | — | `msg.sender` | 2 | |
| CALLVALUE | 0x34 | — | `msg.value` | 2 | 0 in plain `eth_call` unless `value` is set. |
| CALLDATALOAD | 0x35 | `i` | 32 bytes at calldata `i` | 3 | **Zero-padded** past end of calldata. |
| CALLDATASIZE | 0x36 | — | size | 2 | |
| CALLDATACOPY | 0x37 | `destOffset, offset, size` | — | 3 + 3·⌈size/32⌉ + memexp | Copies calldata to memory, **zero-padded** past end. |
| CODECOPY | 0x39 | `destOffset, offset, size` | — | 3 + 3·⌈size/32⌉ + memexp | Copies own code to memory, zero-padded (0x00 = STOP) past end. Used in initcode wrapper. |
| RETURNDATASIZE | 0x3D | — | size of last call's return data | 2 | 0 before any call (Byzantium, EIP-211). Handy 1-byte zero pre-Shanghai. |
| RETURNDATACOPY | 0x3E | `destOffset, offset, size` | — | 3 + 3·⌈size/32⌉ + memexp | **Exceptional halt (all gas) if `offset + size > RETURNDATASIZE`** — unlike CALLDATACOPY, no padding. |
| POP | 0x50 | `x` | — | 2 | |
| MLOAD | 0x51 | `offset` | `mem[offset..offset+32)` | 3 + memexp | |
| MSTORE | 0x52 | `offset, value` | — | 3 + memexp | Writes 32 bytes. |
| MSTORE8 | 0x53 | `offset, value` | — | 3 + memexp | Writes 1 byte: `value & 0xFF`. |
| JUMP | 0x56 | `counter` | — | 8 | Target byte must be a valid `JUMPDEST` (Section 3) else exceptional halt. |
| JUMPI | 0x57 | `counter, b` | — | 10 | Jumps iff `b != 0`. Same target validity rule. |
| PC | 0x58 | — | pc | 2 | Offset of *this* instruction. |
| MSIZE | 0x59 | — | memory size | 2 | Highest touched memory, rounded up to 32. |
| GAS | 0x5A | — | remaining gas | 2 | Value *after* paying for GAS itself. |
| JUMPDEST | 0x5B | — | — | 1 | Jump target marker; no-op otherwise. |
| MCOPY | 0x5E | `destOffset, offset, size` | — | 3 + 3·⌈size/32⌉ + memexp | Memory->memory copy, overlap-safe (acts like memmove). **Cancun, EIP-5656.** |
| PUSH0 | 0x5F | — | `0` | 2 | **Shanghai, EIP-3855.** |
| PUSH1..PUSH32 | 0x60..0x7F | — | immediate value | 3 | N-byte immediate follows the opcode in code; value is right-aligned (zero-extended). |
| DUP1..DUP16 | 0x80..0x8F | top N items unchanged | + copy of Nth item on top | 3 | DUP1 duplicates the top; DUP16 the 16th. |
| SWAP1..SWAP16 | 0x90..0x9F | — | — | 3 | SWAPn swaps top with the (n+1)th item. |
| STATICCALL | 0xFA | `gas, address, argsOffset, argsSize, retOffset, retSize` | `success` (1/0) | memexp + access cost (100 warm / 2600 cold, EIP-2929) + forwarded gas | Byzantium (EIP-214). Calls with state-change ops banned in callee (SSTORE, LOG, CREATE, SELFDESTRUCT, value-CALL, TSTORE -> callee halts exceptionally, success=0). Forwards `min(gas, ⌊63/64 · remaining⌋)` (EIP-150). Copies `min(retSize, RETURNDATASIZE)` bytes to `mem[retOffset..)`; full data remains available via RETURNDATACOPY. On failure (success=0) remaining forwarded gas is refunded to caller; revert data available via RETURNDATASIZE/COPY. |
| RETURN | 0xF3 | `offset, size` | — | 0 + memexp | Halt, success, return `mem[offset..offset+size)`. In initcode: the returned bytes become the runtime code. |
| REVERT | 0xFD | `offset, size` | — | 0 + memexp | Byzantium (EIP-140). Halt, revert state, return data to caller, **unused gas refunded**. |
| INVALID | 0xFE | — | — | all remaining gas | Designated invalid instruction (EIP-141). Exceptional halt, **consumes all gas**. Use only as unreachable padding; prefer REVERT+Panic for real errors. |

Source for operand names/order: evm.codes dataset
(https://github.com/smlxl/evm.codes — `opcodes.json`, e.g. STATICCALL input is exactly
`gas | address | argsOffset | argsSize | retOffset | retSize`; all copy ops are
`destOffset | offset | size`). Interactive reference: https://www.evm.codes/

Per-fork warm/cold: in an `eth_call`, the access-list starts fresh — the **first STATICCALL to
each distinct address costs 2600 (cold), subsequent ones 100 (warm)** (EIP-2929). Precompiles
(0x01..0x0a+), `tx.origin`, and the call target itself start warm.

---

## 3. JUMPDEST validation and label patching

Rules (legacy bytecode; Yellow Paper / EIP-3540 background):

1. A `JUMP`/`JUMPI` target must be the byte offset of a `JUMPDEST` (`0x5B`) **opcode**.
2. **Bytes inside PUSH immediates do not count.** Validity is computed by a single linear scan
   from offset 0: read opcode; if it is PUSHn (`0x60 + n - 1`), skip the next `n` bytes (they
   are data, not opcodes); a `0x5B` encountered *as an opcode* is a valid destination, a `0x5B`
   byte inside push data is not.
3. Jumping to an invalid destination (non-JUMPDEST, push data, or past end of code) is an
   exceptional halt: **all remaining gas in the current frame is consumed**, the frame returns
   failure with empty return data.
4. This is why every basic-block entry that is reached via JUMP/JUMPI must begin with an
   explicit `JUMPDEST` (1 gas, 1 byte). Fallthrough entry does not require one.

**Label patching practice (two-pass assembly):**

- Emit every jump as `PUSH2 0x0000 (placeholder) JUMP/JUMPI`, recording a fixup
  `{ patchOffset, labelId }`.
- After all code is emitted, offsets are final (PUSH2 has fixed width — never "optimize" to
  PUSH1 after the fact or all later offsets shift). Write each label's byte offset big-endian
  into the 2 placeholder bytes.
- **PUSH2 is always sufficient**: runtime code is capped at 24,576 bytes (EIP-170) and initcode
  at 49,152 bytes (EIP-3860); both are < 2^16 = 65,536, so every reachable offset fits in 2
  bytes. (solc uses the same trick; it only widens to PUSH3+ for objects beyond 65,535 bytes,
  which cannot occur under mainnet limits.)
- Optional sanity pass: after assembly, run the scan from rule 2 and assert every patched
  target lands on a `JUMPDEST` opcode.

---

## 4. Size and gas limits

### Code size

- **EIP-170 (Spurious Dragon): max runtime code = 0x6000 = 24,576 bytes.** Enforced at
  deployment time (when initcode RETURNs the runtime code, and for the code of any created
  contract). https://eips.ethereum.org/EIPS/eip-170
  - EIP-7907 would raise this but was deferred out of Fusaka; **24,576 remains the limit in
    mid-2026**.
  - Note: geth's `eth_call` `stateOverride.code` is *not* consensus-validated against EIP-170,
    but stay under it anyway so the same artifact works in deployless mode and on picky
    providers.
- **EIP-3860 (Shanghai): max initcode = 2 × 24,576 = 49,152 bytes**, plus **2 gas per 32-byte
  word of initcode** charged on creation. Relevant for the deployless (`to: null` /
  viem `code` option) execution path, where the whole script ships as initcode.
  https://eips.ethereum.org/EIPS/eip-3860

### Memory expansion cost

For the highest touched word count `a = ⌈(offset + size) / 32⌉`:

```
C_mem(a) = 3·a + ⌊a² / 512⌋
expansion_charge = C_mem(a_new) − C_mem(a_old)      // charged by the op that grows memory
```

Linear (3/word) until ~724 words (~23 KB), then the quadratic term dominates. Examples:
1 KB ≈ 98 gas; 32 KB ≈ 5,120 gas; 1 MB ≈ 2.1M gas; 4 MB ≈ 33M gas. Read scripts that buffer
many call results should reuse scratch regions rather than bump-allocating unboundedly, but for
typical multicall-style scripts (<64 KB memory) cost is negligible.

### eth_call gas caps (headroom for read scripts)

| Environment | Cap on eth_call gas | Notes |
|---|---|---|
| geth | **50,000,000** (default of `--rpc.gascap`; `0` = unlimited) | When the request omits `gas`, geth uses the gascap as the limit. https://geth.ethereum.org/docs/fundamentals/command-line-options |
| anvil (foundry 1.7.x) | **block gas limit, default 30,000,000** | `eth_call` gas is capped at `block.gas_limit`; raise with `--gas-limit <n>` or remove with `--disable-block-gas-limit` (alias `--no-mining` unrelated). https://getfoundry.sh/anvil/reference/anvil/ , https://github.com/foundry-rs/foundry/pull/4389 |
| Alchemy | **550,000,000 per request** (Ethereum, Polygon, Optimism, Arbitrum; mainnet + testnets) | https://www.alchemy.com/docs/reference/gas-limits-for-eth_call-and-eth_estimategas |
| Infura / MetaMask RPC | **10× current block gas limit** (~600M at 60M blocks) | https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_estimategas/ |
| Other clients | Nethermind 100M, Erigon 50M defaults | https://github.com/NethermindEth/nethermind/issues/4360 |
| Protocol (real txs only) | **16,777,216 (2^24) per transaction** since Fusaka (EIP-7825) | Does NOT apply to eth_call. https://eips.ethereum.org/EIPS/eip-7825 |

Practical guidance: design for the **anvil default of 30M** as the worst case in tests (or pass
`--gas-limit 100000000` in the test harness), and treat **50M (geth default)** as the realistic
production floor. Each warm STATICCALL + ABI plumbing is on the order of a few thousand gas, so
50M comfortably covers thousands of reads.

---

## 5. Checked arithmetic (solc >= 0.8 semantics) and revert encodings

### Panic(uint256) encoding

`bytes4(keccak256("Panic(uint256)")) = 0x4e487b71`, followed by one ABI-encoded uint256 code.
Total revert payload = **36 bytes (0x24)**: `0x4e487b71 ++ uint256(code)`.

Codes (Solidity docs, stable since 0.8.x):

| Code | Meaning |
|---|---|
| 0x01 | `assert` failure |
| **0x11** | **arithmetic overflow/underflow** |
| **0x12** | **division or modulo by zero** |
| 0x21 | invalid enum conversion |
| 0x31 | `.pop()` on empty array |
| **0x32** | **array index out of bounds** |
| 0x41 | memory allocation too large |
| 0x51 | call to uninitialized internal function pointer |

`Error(string)` (from `revert("msg")`/`require(_, "msg")`):
`bytes4(keccak256("Error(string)")) = 0x08c379a0`, followed by ABI-encoded `(string)`:
`0x08c379a0 ++ 0x20 (offset) ++ len ++ utf8 bytes right-padded to 32`. evs never needs to
*construct* this — only to bubble it (below) — but decoders (viem) recognize both.

### Shared panic tail (emit once, jump to it)

```
panic11:  JUMPDEST
          PUSH1 0x11
          PUSH2 panic_common JUMP        ; or fall through if adjacent
panic12:  JUMPDEST
          PUSH1 0x12
panic_common:                            ; stack: [code]
          JUMPDEST
          PUSH4 0x4e487b71
          PUSH1 0xE0
          SHL                            ; selector << 224 (left-aligned word)
          PUSH0  MSTORE                  ; mstore(0x00, selectorWord)
          PUSH1 0x04  MSTORE             ; mstore(0x04, code)  — pops offset=4, value=code
          PUSH1 0x24  PUSH0  REVERT      ; revert(0x00, 36)
```

(Stack check on the tail: `[code]` -> PUSH4/PUSH1/SHL -> `[selWord, code]` -> PUSH0 ->
`[0, selWord, code]` -> MSTORE pops offset=0, value=selWord -> `[code]` -> PUSH1 0x04 ->
`[4, code]` -> MSTORE -> `[]` -> PUSH1 0x24 PUSH0 -> `[0, 0x24]` -> REVERT(offset=0, size=0x24).)

### Checked uint256 ops (stack shown top-first; result left on stack)

**ADD** — overflow iff `r < b` (equivalently `r < a`). Yul: `r := add(a,b)  if lt(r, a) { panic11 }`

```
; stack: [a, b]
DUP2          ; [b, a, b]
ADD           ; [r, b]          r = a + b
DUP1          ; [r, r, b]
SWAP2         ; [b, r, r]
GT            ; [b > r, r]      overflow flag
PUSH2 panic11
JUMPI         ; [r]
```

**SUB** — underflow iff `b > a` (computing `a - b`). Yul: `if lt(a, b) { panic11 }  r := sub(a, b)`

```
; stack: [a, b]
DUP2  DUP2    ; [a, b, a, b]
LT            ; [a < b, a, b]
PUSH2 panic11
JUMPI         ; [a, b]
SUB           ; [a - b]
```

**MUL** — overflow iff `a != 0 && r / a != b`. Yul:
`r := mul(a,b)  if iszero(or(iszero(a), eq(div(r, a), b))) { panic11 }`

```
; stack: [a, b]
DUP2  DUP2    ; [a, b, a, b]
MUL           ; [r, a, b]
SWAP2         ; [b, a, r]
DUP3          ; [r, b, a, r]
DUP3          ; [a, r, b, a, r]
SWAP1         ; [r, a, b, a, r]
DIV           ; [r/a, b, a, r]   (DIV(_, 0) = 0, harmless: a==0 branch ORs it away)
EQ            ; [r/a == b, a, r]
SWAP1         ; [a, eq, r]
ISZERO        ; [a == 0, eq, r]
OR            ; [ok, r]
ISZERO        ; [overflow, r]
PUSH2 panic11
JUMPI         ; [r]
```

**DIV** — EVM returns 0 on `/0`; Solidity panics 0x12 instead. (Unsigned division cannot overflow.)

```
; stack: [a, b]      computing a / b
DUP2          ; [b, a, b]
ISZERO        ; [b == 0, a, b]
PUSH2 panic12
JUMPI         ; [a, b]
DIV           ; [a / b]
```

**MOD** — identical shape with `MOD`; panic 0x12 when `b == 0`.

**Signed variants** (only if evs exposes int256): same zero-divisor check for SDIV/SMOD
(panic 0x12); SDIV additionally panics 0x11 on the lone overflow case
`a == -2^255 && b == -1` (check: `and(eq(a, shl(255, 1)), eq(b, not(0)))`). Checked signed
add/sub/mul need sign-aware bound checks (see solc's Yul utils `checked_add_t_int256` for
reference); recommend shipping unsigned-only first.

### Bubbling reverts from failed STATICCALLs

Do not decode — re-revert the callee's return data verbatim (works for Error(string),
Panic(uint256), and custom errors alike):

```
; ... STATICCALL                ; stack: [success]
PUSH2 ok
JUMPI                           ; jump if success != 0
; -- failure path --
RETURNDATASIZE  PUSH0  PUSH0    ; [destOffset=0, offset=0, size=rds]
RETURNDATACOPY                  ; mem[0..rds) = revert payload
RETURNDATASIZE  PUSH0           ; [offset=0, size=rds]
REVERT
ok: JUMPDEST
```

`RETURNDATACOPY` here is always safe: `offset=0, size=RETURNDATASIZE` can never exceed the
return buffer. Outer `eth_call` then surfaces the original revert data, and viem decodes it
against the generated ABI / standard errors automatically.

---

## 6. Memory layout conventions and the initcode wrapper

### Solidity-compatible memory map (worth copying)

| Range | Use |
|---|---|
| `0x00 – 0x3f` | **Scratch** (2 words) — hashing, building revert payloads, short-lived temporaries between statements. Never assume it survives a helper. |
| `0x40 – 0x5f` | **Free memory pointer.** Initialize once at entry: `mstore(0x40, 0x80)`. Allocation = `ptr := mload(0x40); mstore(0x40, add(ptr, size_rounded_to_32))`. Memory is never freed. |
| `0x60 – 0x7f` | **Zero slot.** Must always read as 0 (Solidity uses it as the canonical empty dynamic-array body). Never write it. If evs never interops with Solidity-style internal pointers, it may reuse this — but keeping the convention costs one word. |
| `0x80 +` | Allocated data: call argument buffers, returndata staging, the final return tuple. |

Prologue evs should emit:

```
PUSH1 0x80  PUSH1 0x40  MSTORE     ; mstore(0x40, 0x80)  — 5 bytes
```

A convenient pattern for each `s.call(...)`: build calldata at the free pointer
(selector via `PUSH4 sel PUSH1 0xE0 SHL MSTORE`, then 32-byte args), STATICCALL with
`retOffset/retSize` pointing at a fresh allocation sized from the ABI, check `success`,
bubble on failure (Section 5), then `MLOAD`/bounds-check dynamic returndata via
`RETURNDATASIZE` + `RETURNDATACOPY` when sizes aren't static.

### Minimal initcode wrapper (returns runtime code)

10-byte Shanghai+ wrapper; `RRRR` = big-endian runtime length, runtime bytes are appended
immediately after (at offset `0x0A`):

```
bytes:  61 RR RR 80 60 0A 5F 39 5F F3 <runtime...>

61 RRRR   PUSH2 runtimeLen        ; [len]
80        DUP1                    ; [len, len]
60 0A     PUSH1 0x0A              ; [0x0A, len, len]   (10 = wrapper size)
5F        PUSH0                   ; [0, 0x0A, len, len]
39        CODECOPY                ; mem[0..len) = code[0x0A .. 0x0A+len) ; [len]
5F        PUSH0                   ; [0, len]
F3        RETURN                  ; return mem[0..len)  => runtime code
```

Pre-Shanghai variant (same 10 bytes) replaces each `5F` with `3D` (`RETURNDATASIZE`, guaranteed
0 since no call has occurred): `61 RRRR 80 60 0A 3D 39 3D F3`.

Constraints: `runtimeLen <= 24,576` (EIP-170, enforced when RETURN executes in a creation
frame) and `10 + runtimeLen <= 49,152` (EIP-3860 initcode cap) — the first bound is always the
binding one. No constructor arguments are needed for evs scripts.

### Two execution paths the artifact must serve

1. **State override:** `eth_call({ to: SCRIPT_ADDR, data }, "latest", { [SCRIPT_ADDR]: { code: runtimeHex } })`
   — geth-style third parameter (object keyed by address; fields `balance`, `nonce`, `code`,
   `state`, `stateDiff`). Ship **runtime** bytecode here.
   https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth
2. **Deployless (viem `code` / factory pattern):** the call is wrapped so the node executes
   **initcode** that instantiates the script and forwards the call; EIP-3860's 49,152-byte
   initcode cap and 2-gas-per-word charge apply. Ship runtime + the 10-byte wrapper above.
   https://viem.sh/docs/actions/public/call#deployless-calls

---

## Source index

- evm.codes interactive reference: https://www.evm.codes/ (data: https://github.com/smlxl/evm.codes)
- Fusaka mainnet announcement (activation 2025-12-03): https://blog.ethereum.org/2025/11/06/fusaka-mainnet-announcement
- Fusaka overview + EIP list: https://ethereum.org/roadmap/fusaka/
- EOF removed from Fusaka (ACD 2025-04-28): https://thedefiant.io/news/blockchains/ethereum-removes-evm-object-format-fusaka-upgrade-eyes-glamsterdam-b97edac0 , https://blockworks.co/news/ethereum-consensus-evm-upgrade-fusaka-devs
- Foundry releases (v1.7.1, 2026-05-08): https://github.com/foundry-rs/foundry/releases
- Foundry default EVM -> osaka (v1.6.0): https://github.com/foundry-rs/foundry/issues/12730
- anvil reference (`--hardfork` default `latest`, `--disable-block-gas-limit`): https://getfoundry.sh/anvil/reference/anvil/
- geth `--rpc.gascap` default 50M: https://geth.ethereum.org/docs/fundamentals/command-line-options
- Alchemy 550M eth_call cap: https://www.alchemy.com/docs/reference/gas-limits-for-eth_call-and-eth_estimategas
- Infura 10× block gas limit cap: https://docs.metamask.io/services/reference/ethereum/json-rpc-methods/eth_estimategas/
- EIP-170: https://eips.ethereum.org/EIPS/eip-170 · EIP-3860: https://eips.ethereum.org/EIPS/eip-3860
- EIP-3855 (PUSH0): https://eips.ethereum.org/EIPS/eip-3855 · EIP-5656 (MCOPY): https://eips.ethereum.org/EIPS/eip-5656
- EIP-2929 (warm/cold): https://eips.ethereum.org/EIPS/eip-2929 · EIP-150 (63/64): https://eips.ethereum.org/EIPS/eip-150
- EIP-140 (REVERT) / EIP-211 (RETURNDATA*) / EIP-214 (STATICCALL): https://eips.ethereum.org/EIPS/eip-140 , https://eips.ethereum.org/EIPS/eip-211 , https://eips.ethereum.org/EIPS/eip-214
- EIP-7825 (2^24 tx gas cap): https://eips.ethereum.org/EIPS/eip-7825 · EIP-7939 (CLZ): https://eips.ethereum.org/EIPS/eip-7939
- Solidity error encodings (Panic/Error): https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
