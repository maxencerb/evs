/**
 * `viem.ts` — the viem-facing edge of an artifact, in three sections:
 *
 * 1. the init-code wrapper (`toCreationBytecode`) that turns the runtime into the creation
 *    bytecode deployless mode needs;
 * 2. the two `toViem()` shapes (`ToViemMode`): deployless (`toViemDeployless`) and state
 *    override (`toViemStateOverride`, which also covers sender mode), and the `toViem()` a
 *    compiled and a precompiled script share: its overloads (`ToViem`) and the one
 *    implementation behind them (`createToViem`);
 * 3. client-side error decoding (`decodeScriptError`, `matchScriptError`): the caught viem error
 *    or raw revert bytes → a `name`-discriminated value typed from the script ABI. Users call
 *    viem directly, so there are no call wrappers.
 *
 * Init wrapper and execution shapes:
 *
 * - viem's deployless `code` parameter expects CREATION bytecode — passing runtime bytecode
 *   fails SILENTLY (empirically verified). The artifact therefore only
 *   ever exposes creation bytecode under a key named `code`; the raw fields are named
 *   `runtimeBytecode` / `initBytecode` deliberately.
 * - The fixed 10-byte wrapper (golden-tested in viem.test.ts) is `61 RRRR 80 600A 5F 39 5F F3`
 *   (RRRR = runtime length, big-endian PUSH2 immediate). The paris variant swaps `5F` (PUSH0)
 *   for `3D` (RETURNDATASIZE — zero at the start of an init frame):
 *
 *     61 RRRR   PUSH2 len        [len]
 *     80        DUP1             [len, len]
 *     60 0A     PUSH1 0x0A       [10, len, len]
 *     5F        PUSH0            [0, 10, len, len]
 *     39        CODECOPY         [len]            ; mem[0..len) = code[10..10+len)
 *     5F        PUSH0            [0, len]
 *     F3        RETURN                            ; return mem[0..len) — the runtime
 *
 * - State-override mode takes runtime bytecode directly at a deterministic address;
 *   `DEFAULT_SCRIPT_ADDRESS` is the last 20 bytes of keccak256("evs.script") — no
 *   code/storage/balance on any major chain.
 *
 * Error decoding:
 *
 * - The revert payload is found by DUCK TYPING the error tree (`name`, `code`, `raw`, `data`,
 *   `cause`), never `instanceof`: the error may come from another copy of viem than evs resolves.
 *   `revertDataOf` states the one rule for what is a revert. Anything else decodes to `undefined`
 *   and `matchScriptError` rethrows it (a non-`Error` value becomes an `EvsTypeError`): a
 *   transport or provider failure is not a script error.
 * - The payload is classified by the classifier `explainRevert` also uses (`abi/revert.ts`), so
 *   the two never disagree: Solidity's `Panic`/`Error` by their fixed selectors, then the error
 *   entries of the ABI handed in (declared errors plus the evs runtime errors) by selector.
 *   Anything else, including a matched selector whose args do not decode, is `unknown`; a
 *   0-byte revert is `empty`.
 */

import type { Abi, AbiParameter, AbiParameterToPrimitiveType, Address } from 'viem';

import { describePanic, EVS_ERROR_NAMES, type EvsRuntimeErrorName } from './abi/artifact.js';
import { classifyRevert, errorTableOf } from './abi/revert.js';
import {
  EVM_VERSIONS,
  forkAtLeast,
  isEvmVersion,
  PUSH0_FORK,
  type EvmVersion,
} from './asm/forks.js';
import { HEX_BYTES_RE, isHexString } from './core/bytes.js';
import { EvsCompileError, EvsTypeError } from './core/errors.js';
import type { Hex } from './core/types.js';

// ---------------------------------------------------------------------------
// init wrapper (the fixed 10-byte builder)
// ---------------------------------------------------------------------------

/** EIP-170 keeps runtimes ≤ 24,576, far below the PUSH2 immediate ceiling. */
const PUSH2_MAX = 0xffff;

/** `'paris', 'shanghai' or 'cancun'` — the supported forks, as the error message lists them. */
const QUOTED_VERSIONS = EVM_VERSIONS.map((v) => `'${v}'`);
const EXPECTED_VERSIONS = `${QUOTED_VERSIONS.slice(0, -1).join(', ')} or ${QUOTED_VERSIONS.slice(-1).join('')}`;

/** The `evmVersion` whitelist check shared with `compile()` (`prefix` names the caller). */
export function assertEvmVersion(
  evmVersion: string,
  prefix = '',
): asserts evmVersion is EvmVersion {
  if (!isEvmVersion(evmVersion)) {
    throw new EvsCompileError(
      'EVM_VERSION',
      `${prefix}unknown evmVersion ${JSON.stringify(evmVersion)} — expected ${EXPECTED_VERSIONS}`,
    );
  }
}

function runtimeByteLength(runtime: Hex, where: string): number {
  if (typeof runtime !== 'string' || !HEX_BYTES_RE.test(runtime)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: runtime bytecode must be 0x-prefixed even-length hex`,
    );
  }
  return (runtime.length - 2) / 2;
}

/** The 10-byte wrapper for a given runtime length (`61 RRRR 80 600A 5F 39 5F F3`). */
function initWrapper(runtimeLength: number, evmVersion: EvmVersion): Hex {
  // PUSH0_FORK, not `OPS.PUSH0.since`: this module is part of the compiler-free runtime entry,
  // and a reference to the opcode table would keep all of it in every client bundle
  const zero = forkAtLeast(evmVersion, PUSH0_FORK) ? '5f' : '3d';
  const len = runtimeLength.toString(16).padStart(4, '0');
  return `0x61${len}80600a${zero}39${zero}f3`;
}

/**
 * The shanghai/cancun wrapper template, `61 RRRR 80 600A 5F 39 5F F3`, with the PUSH2 runtime
 * length `RRRR` (bytes 1–2) zeroed — `toCreationBytecode` patches the real length in. Exposed
 * for golden tests and inspection; prepending it verbatim only round-trips a 0-byte runtime.
 */
export const INIT_CODE_PREFIX_SHANGHAI: Hex = /* @__PURE__ */ initWrapper(0, 'shanghai');

/**
 * `initBytecode = wrapper(len) ++ runtime`. The wrapper CODECOPYs
 * everything after itself and RETURNs it as the deployed code, so a creation-frame `eth_call`
 * (viem deployless `code` mode) executes the runtime unchanged.
 */
export function toCreationBytecode(runtime: Hex, evmVersion: EvmVersion): Hex {
  assertEvmVersion(evmVersion);
  const length = runtimeByteLength(runtime, 'toCreationBytecode');
  if (length > PUSH2_MAX) {
    throw new EvsCompileError(
      'COMPILE_LIMIT',
      `toCreationBytecode: runtime is ${length} bytes — beyond the PUSH2 length immediate ` +
        `(${PUSH2_MAX}) and far beyond the EIP-170 limit of 24576`,
    );
  }
  const wrapper = initWrapper(length, evmVersion);
  return `0x${wrapper.slice(2)}${runtime.slice(2)}`;
}

// ---------------------------------------------------------------------------
// toViem shapes
// ---------------------------------------------------------------------------

/**
 * Default script address for state-override mode: last 20 bytes of keccak256("evs.script").
 * No code/storage/balance on any major chain; replaceable per call.
 */
export const DEFAULT_SCRIPT_ADDRESS: Address = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530';

/**
 * Deployless mode — maximum RPC compatibility: a plain 2-parameter `eth_call` with `to`
 * omitted. Spread the result into `readContract` (`code` must be CREATION bytecode — this is
 * why the input field is named `initBytecode`). The node runs it as a contract creation, so its
 * limits apply (result ≤ 24,576 bytes and not starting with 0xEF, creation data ≤ 49,152
 * bytes): see `deployless.ts`.
 */
export function toViemDeployless<const abi extends Abi | readonly unknown[]>(s: {
  abi: abi;
  initBytecode: Hex;
}): { abi: abi; code: Hex } {
  return { abi: s.abi, code: s.initBytecode };
}

/**
 * The two execution modes `toViem()` takes. Exported so a mode chosen at run time (a config
 * value, a provider probe) can be typed once and passed straight through: `toViem({ mode })`
 * with a `ToViemMode`-typed `mode` resolves to the catch-all overload and returns the union of
 * the shapes.
 */
export type ToViemMode = 'deployless' | 'stateOverride';

/** The options object of `toViem()`'s implementation (the union of every overload's input). */
interface ToViemOptions {
  mode?: ToViemMode | undefined;
  address?: Address | undefined;
  sender?: Address | undefined;
}

/**
 * The state-override execution shape: `{ abi, address, stateOverride }`. The one-entry tuple is
 * mutable (not `readonly`) because viem's `StateOverride` is a mutable `Array` type — a
 * readonly tuple would not spread into `readContract`.
 */
interface ViemStateOverrideShape<abi extends Abi | readonly unknown[]> {
  abi: abi;
  address: Address;
  stateOverride: [{ address: Address; code: Hex }];
}

/** The sender-mode shape (issue #36): state override AT the sender address plus `account`. */
interface ViemSenderShape<
  abi extends Abi | readonly unknown[],
> extends ViemStateOverrideShape<abi> {
  account: Address;
}

/**
 * State-override mode — deterministic `address(this)`, controllable `msg.sender` (via the
 * `account` call parameter). Spread the result into `readContract`; requires a provider
 * supporting the third `eth_call` parameter.
 *
 * `sender` (issue #36) — run the script AS `sender`: the runtime is installed at the sender's
 * own address and the eth_call's `account` is set to it, so every sub-call target (`s.read`,
 * `s.call`, `s.simulate` and their `try*` variants) sees `msg.sender = sender` — the script
 * self-calls through that address — and `s.env('caller')`/`s.env('address')` both read `sender`.
 * This is the only way to give a simulated write a chosen `msg.sender` (permit-style checks,
 * `onlyOwner` views, ERC-4626 `maxWithdraw(owner)` patterns): there is no in-frame EVM primitive
 * for it. Caveats: the override REPLACES the code at `sender` for the duration of the call (a
 * contract sender — a Safe, say — cannot answer callbacks), while its balance, nonce and storage
 * stay in place. `sender` and `address` are the same knob; passing both with different values
 * throws. A `sender` or `address` that is not a 20-byte 0x address throws `EvsTypeError`
 * (`TYPE_MISMATCH`).
 */
export function toViemStateOverride<const abi extends Abi | readonly unknown[]>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts: { address?: Address; sender: Address },
): ViemSenderShape<abi>;
export function toViemStateOverride<const abi extends Abi | readonly unknown[]>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address; sender?: undefined },
): ViemStateOverrideShape<abi>;
export function toViemStateOverride<const abi extends Abi | readonly unknown[]>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address | undefined; sender?: Address | undefined },
): ViemStateOverrideShape<abi> | ViemSenderShape<abi>;
export function toViemStateOverride<const abi extends Abi | readonly unknown[]>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address | undefined; sender?: Address | undefined },
): ViemStateOverrideShape<abi> | ViemSenderShape<abi> {
  const sender = opts?.sender;
  if (opts?.address !== undefined && !isAddressLike(opts.address)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `toViem: \`address\` must be a 20-byte 0x address, got ${JSON.stringify(opts.address)}`,
    );
  }
  if (sender !== undefined) {
    if (!isAddressLike(sender)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `toViem: \`sender\` must be a 20-byte 0x address, got ${JSON.stringify(sender)}`,
      );
    }
    if (opts?.address !== undefined && opts.address.toLowerCase() !== sender.toLowerCase()) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `toViem: \`sender\` (${sender}) and \`address\` (${opts.address}) disagree — sender mode installs the script AT the sender address; pass one or the other`,
      );
    }
    return {
      abi: s.abi,
      address: sender,
      stateOverride: [{ address: sender, code: s.runtimeBytecode }],
      account: sender,
    };
  }
  const address = opts?.address ?? DEFAULT_SCRIPT_ADDRESS;
  return {
    abi: s.abi,
    address,
    stateOverride: [{ address, code: s.runtimeBytecode }],
  };
}

function isAddressLike(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * The `toViem()` of a script whose ABI is `abi`: one overload per execution shape, each result
 * made to be spread into viem's `readContract`. A compiled script (`CompiledEvsScript`) and a
 * precompiled one (`PrecompiledScript`) expose this same member.
 *
 * deployless (default): a contract-creation eth_call, so the result must fit 24,576 bytes and
 * not start with 0xEF, and viem's creation data (args included) must fit 49,152 bytes — see
 * deploylessDataSize / explainDeploylessError; stateOverride mode has none of these limits.
 */
export interface ToViem<abi extends Abi | readonly unknown[]> {
  (): { abi: abi; code: Hex };
  (o: { mode: 'deployless' }): { abi: abi; code: Hex };
  // NOTE: the stateOverride tuple is mutable (not `readonly`) because viem's `StateOverride`
  // is a mutable `Array` type — a readonly tuple would not spread into `readContract`.
  (o: { mode: 'stateOverride'; address?: Address }): {
    abi: abi;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
  };
  // sender mode (issue #36): the runtime is installed AT `sender` and `account` is set to it, so
  // every sub-call target sees `msg.sender = sender` (the script self-calls through that address).
  // `address` may restate `sender` (same knob); a different value throws.
  (o: { mode: 'stateOverride'; sender: Address; address?: Address }): {
    abi: abi;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
    account: Address;
  };
  // catch-all for a mode chosen at run time (`mode: ToViemMode`): the union of the shapes above.
  // `address` / `sender` apply only when the mode turns out to be 'stateOverride' (deployless
  // ignores them). The mode may also be optional or `| undefined` (a config field that defaults
  // to deployless, as at run time). The intersection is `never` unless `m` minus `undefined` is
  // the whole union, which keeps a literal mode on its own overload: e.g.
  // `{ mode: 'deployless', address }` stays a type error. The `never` default covers a missing
  // `mode` key (no inference candidate), so `{}` / `{ address }` stay type errors too.
  <m extends ToViemMode | undefined = never>(
    o: {
      mode?: m;
      address?: Address | undefined;
      sender?: Address | undefined;
    } & ([ToViemMode] extends [Exclude<m, undefined>] ? unknown : never),
  ):
    | { abi: abi; code: Hex }
    | {
        abi: abi;
        address: Address;
        stateOverride: [{ address: Address; code: Hex }];
      }
    | {
        abi: abi;
        address: Address;
        stateOverride: [{ address: Address; code: Hex }];
        account: Address;
      };
}

/**
 * The one implementation behind every {@link ToViem} overload: the mode picks the shape, and
 * `toViemStateOverride` owns the address default and the `address` / `sender` checks.
 */
export function createToViem<const abi extends Abi | readonly unknown[]>(s: {
  abi: abi;
  runtimeBytecode: Hex;
  initBytecode: Hex;
}): ToViem<abi> {
  const toViem = (o?: ToViemOptions) =>
    o?.mode === 'stateOverride' ? toViemStateOverride(s, o) : toViemDeployless(s);
  // the overloads narrow the implementation's union return per input shape
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return toViem as ToViem<abi>;
}

// ---------------------------------------------------------------------------
// client-side error decoding (issue #15) — NO call wrappers: users call viem directly
// (the errors ride in the script ABI, so viem already decodes reverts); these utilities
// turn the CAUGHT error (or raw revert bytes) into a typed, switchable value.
// ---------------------------------------------------------------------------

/** Every `{ type: 'error' }` entry of the script ABI (declared errors + the evs built-ins). */
type AbiErrorEntries<abi> = abi extends readonly unknown[]
  ? Extract<abi[number], { readonly type: 'error' }>
  : never;

/** The record key of one error input: its name (all script-declared inputs are named — the
 *  `arg{i}` fallback is applied at declaration). Unnamed inputs of a foreign ABI are dropped
 *  from the TYPE (the runtime still keys them `arg{i}`). */
type ParamKey<p> = p extends { readonly name: infer n extends string }
  ? n extends ''
    ? never
    : n
  : never;

/** One error entry's decoded args as a name-keyed record (abitype-inferred value types). */
export type ErrorArgsOf<e> = e extends {
  readonly inputs: infer inputs extends readonly AbiParameter[];
}
  ? { readonly [p in inputs[number] as ParamKey<p>]: AbiParameterToPrimitiveType<p, 'inputs'> }
  : Readonly<Record<string, unknown>>;

/** The decoded arm of one ABI error entry: discriminated by `name`, args as a named record. */
type DecodedAbiError<abi> =
  AbiErrorEntries<abi> extends infer e
    ? e extends { readonly type: 'error'; readonly name: infer n extends string }
      ? { readonly name: n; readonly args: ErrorArgsOf<e>; readonly raw: Hex }
      : never
    : never;

/** The non-ABI arms every decode can produce: the Solidity built-ins, an unrecognized
 *  selector (e.g. a callee error bubbled verbatim), and the empty revert. */
export type DecodedBuiltinError =
  | { readonly name: 'Panic'; readonly code: bigint; readonly meaning: string; readonly raw: Hex }
  | { readonly name: 'Error'; readonly reason: string; readonly raw: Hex }
  | { readonly name: 'unknown'; readonly selector: Hex; readonly raw: Hex }
  | { readonly name: 'empty'; readonly raw: '0x' };

/**
 * The discriminated union `decodeScriptError` yields: one arm per script-ABI error entry
 * (declared errors AND the evs built-ins `EvsInvalidCalldata`/`EvsDecodeError`), plus the
 * built-in arms. Switch on `name` — TS narrows `args` per arm.
 */
export type DecodedScriptError<abi extends Abi | readonly unknown[] = Abi> =
  | DecodedAbiError<abi>
  | DecodedBuiltinError;

/** viem's own test for a node message that reports a revert (`ExecutionRevertedError.nodeMessage`). */
const SAYS_REVERTED = /execution reverted|gas required exceeds allowance/i;

function saysReverted(message: unknown): boolean {
  return typeof message === 'string' && SAYS_REVERTED.test(message);
}

/** The `data` string of the OpenEthereum family: the word, then the revert bytes. */
const REVERTED_DATA = /^Reverted (0x(?:[0-9a-fA-F]{2})*)$/;

/** JSON-RPC's "execution reverted" and "internal error" codes. */
const RPC_REVERTED = 3;
const RPC_INTERNAL = -32603;

/** How deep an RPC error is read into the error objects nested in its `data`. */
const RPC_NESTING = 2;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** What one RPC error says: whether it reports a revert, and the revert bytes it carries. */
interface RpcReading {
  reverted: boolean;
  data: Hex | undefined;
}

/**
 * Reads one RPC error: a node of the error tree with a numeric `code`, or an error object
 * nested in the `data` of one (signs 2 to 4 of {@link revertDataOf}).
 */
function readRpcError(error: Readonly<Record<string, unknown>>, depth = 0): RpcReading {
  // viem keeps the node's message in `details` (its own `message` is a formatted report); the
  // bare JSON-RPC error object has it in `message`
  const message = typeof error.details === 'string' ? error.details : error.message;
  const reading: RpcReading = {
    reverted: error.code === RPC_REVERTED || saysReverted(message),
    data: undefined,
  };
  const readNested = (nested: unknown): void => {
    if (!isObject(nested) || depth >= RPC_NESTING) return;
    const inner = readRpcError(nested, depth + 1);
    reading.reverted ||= inner.reverted;
    reading.data ??= inner.data;
  };
  const data = error.data;
  if (typeof data === 'string') {
    if (isHexString(data)) {
      reading.data = data;
    } else {
      const bytes = REVERTED_DATA.exec(data)?.[1];
      if (isHexString(bytes)) {
        reading.reverted = true;
        reading.data = bytes;
      }
    }
  } else {
    readNested(data);
  }
  readNested(error.originalError);
  if (error.code === RPC_INTERNAL && reading.data !== undefined) reading.reverted = true;
  return reading;
}

/**
 * Pulls the raw revert payload out of `input`, or returns `undefined` when `input` is not a
 * revert. A `0x…` string is revert bytes, taken verbatim. An error is walked down its `cause`
 * chain, and THE RULE below decides: this is the one place that says what a revert is.
 *
 * An error is a revert when its chain shows at least one of these signs:
 *
 * 1. viem's verdict: a node named `ExecutionRevertedError`. viem builds one when the node
 *    answered with code 3, or with a message that says "execution reverted".
 * 2. The same two signs on an RPC error itself: `code === 3`, or such a message. Scroll and
 *    Sonic answer an empty revert with code -32000, that message and no `data`.
 * 3. Revert bytes under the internal-error code: `code === -32603` with hex `data`, directly or
 *    in the error object nested there (`data.data`, `data.originalError.data`), which is how
 *    wallets and development nodes wrap a revert. The code alone is no sign: "Internal error",
 *    an upstream timeout and an out-of-gas all use it.
 * 4. `data: "Reverted 0x…"` on an RPC error (the OpenEthereum family).
 * 5. A `ContractFunctionRevertedError` with a hex `raw`: viem copies it from the `data` of an
 *    answer of signs 2 and 3. Its name alone is no sign, since viem builds one for every
 *    -32603 answer. Before viem 2.47.5 this error has no `cause`, so the RPC error is out of
 *    reach and the node's message survives only as `reason`: a `reason` that says "execution
 *    reverted" is the sign there.
 *
 * An RPC error is a node with a numeric `code` (viem's `RpcRequestError`, the JSON-RPC error
 * object under it, a provider's own error), read with the error objects nested in its `data`.
 * Hex `data` on any other node is NOT revert data: viem's `AbiDecoding*` errors keep a
 * successful result there. And hex `data` without a sign is not either: avalanchego answers a
 * rejected creation with code 0 and the rejected code in `data`.
 *
 * The payload of a revert is the `raw` of sign 5, else the bytes an RPC error carries, else
 * `0x`: a revert whose bytes the node did not send is the empty revert.
 *
 * Deliberately duck-typed, never `instanceof`: the error may come from ANOTHER copy of viem
 * than the one evs was bundled or resolved with (two bundles on a page, a pnpm-duplicated
 * version, a monorepo with two lockfile entries). Class identity would then fail and a real
 * revert would be rethrown as "not a script error"; the shape of the tree is stable across
 * copies.
 */
function revertDataOf(input: unknown): Hex | undefined {
  if (typeof input === 'string') {
    return isHexString(input) ? input : undefined;
  }
  let reverted = false;
  let raw: Hex | undefined;
  let rpcData: Hex | undefined;
  const seen = new Set<object>();
  let current: unknown = input;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    if (current.name === 'ExecutionRevertedError') {
      reverted = true;
    } else if (current.name === 'ContractFunctionRevertedError') {
      if (isHexString(current.raw)) {
        reverted = true;
        raw ??= current.raw;
      } else if (saysReverted(current.reason)) {
        reverted = true;
      }
    } else if (typeof current.code === 'number') {
      const reading = readRpcError(current);
      reverted ||= reading.reverted;
      rpcData ??= reading.data;
    }
    current = current.cause;
  }
  if (!reverted) return undefined;
  return raw ?? rpcData ?? '0x';
}

/**
 * Decodes a caught error (or raw revert bytes) against a script's ABI into a typed,
 * `name`-discriminated value (issue #15). Accepts the UNTOUCHED value from `catch` — the viem
 * error tree of `readContract`/`call`, from any copy or version of viem — or a `0x…` payload
 * (e.g. `error.raw`, `extractRevertData` output, stored bytes).
 *
 * Returns `undefined` when `input` is not a revert (a network error, a timeout, a rate limit,
 * a provider's internal error, a result that does not decode, a non-viem throw): that is "not a
 * script error" — rethrow it, don't switch on it. `revertDataOf` holds the rule.
 * A recognized-but-malformed payload (a declared selector whose args don't decode) yields the
 * `unknown` arm rather than lying about the args.
 */
export function decodeScriptError<const abi extends Abi | readonly unknown[]>(
  script: { readonly abi: abi },
  input: unknown,
): DecodedScriptError<abi> | undefined {
  const raw = revertDataOf(input);
  if (raw === undefined) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime decode below produces exactly the literal-typed union's shapes
  return decodeRevertData(script.abi, raw) as DecodedScriptError<abi>;
}

/** The `decodeScriptError` presentation of the shared classifier (`abi/revert.ts`). */
function decodeRevertData(abi: Abi | readonly unknown[], raw: Hex): DecodedScriptError {
  const c = classifyRevert(raw, errorTableOf(abi));
  switch (c.kind) {
    case 'empty':
      return { name: 'empty', raw: '0x' };
    case 'short':
      return { name: 'unknown', selector: raw, raw };
    case 'panic':
      return { name: 'Panic', code: c.code, meaning: describePanic(c.code).meaning, raw };
    case 'error-string':
      return { name: 'Error', reason: c.reason, raw };
    case 'abi-error':
      // a recognized selector whose payload does not decode never lies about its args
      return c.args === null
        ? { name: 'unknown', selector: c.selector, raw }
        : { name: c.entry.name, args: c.args, raw };
    default: // 'unknown'
      return { name: 'unknown', selector: c.selector, raw };
  }
}

/** The error names `matchScriptError` takes a handler for, and requires one for: every
 *  script-ABI error except the two evs runtime errors. Those, like Panic / Error / unknown /
 *  empty, always reach the `_` default arm. */
type DeclaredNames<abi> = Exclude<
  AbiErrorEntries<abi> extends infer e
    ? e extends { readonly name: infer n extends string }
      ? n
      : never
    : never,
  EvsRuntimeErrorName
>;

/** The decoded args record of the error named `n` (never for arms that carry no args —
 *  distributes, so a wide `abi` degrades gracefully instead of erroring on the built-ins). */
type ErrorArgsByName<abi, n> =
  Extract<
    DecodedScriptError<abi extends Abi | readonly unknown[] ? abi : never>,
    {
      readonly name: n;
    }
  > extends infer d
    ? d extends { readonly args: infer a }
      ? a
      : never
    : never;

/** The handler record for {@link matchScriptError}: one REQUIRED handler per declared error
 *  (adding an error to the script without updating the switch is a type error) plus the
 *  REQUIRED `_` default (an unknown revert is always possible — panics, bubbled callee
 *  errors, future script versions). */
export type ScriptErrorHandlers<abi extends Abi | readonly unknown[], r> = {
  readonly [n in DeclaredNames<abi>]: (
    args: ErrorArgsByName<abi, n>,
    error: Extract<DecodedScriptError<abi>, { readonly name: n; readonly args: unknown }>,
  ) => r;
} & {
  // only the declared (args-carrying) arms are excluded: a built-in arm that shares a name
  // with a hand-built ABI error (e.g. 'empty') still reaches `_` at runtime (issue #62)
  readonly _: (
    error: Exclude<
      DecodedScriptError<abi>,
      { readonly name: DeclaredNames<abi>; readonly args: unknown }
    >,
  ) => r;
};

/** The union of every handler's return type — {@link matchScriptError}'s result. */
export type HandlerResult<handlers> = {
  [k in keyof handlers]: handlers[k] extends (...args: never[]) => infer r ? r : never;
}[keyof handlers];

/**
 * `never` under every key of `handlers` that is neither a declared error nor `_`, `unknown`
 * under the others. Part of the constraint of the handlers of {@link matchScriptError}: it makes
 * a handler under such a key (`Panic`, `EvsDecodeError`, a misspelled error name) a type error,
 * because nothing would ever call it. {@link ScriptErrorHandlers} alone accepts extra keys, as
 * every constraint does.
 */
type OnlyDeclaredHandlers<abi, handlers> = {
  readonly [k in keyof handlers]: k extends DeclaredNames<abi> | '_' ? unknown : never;
};

/**
 * Exhaustive switch over a script's error set (issue #15): decodes the caught error via
 * {@link decodeScriptError} and dispatches to the matching handler — declared errors receive
 * their typed args record; everything else (Panic, Error(string), the evs runtime errors,
 * unknown selectors, the empty revert) lands in `_`, whatever other keys `handlers` holds.
 *
 * If the input is not a revert (transport failure, timeout, provider error, non-viem throw),
 * the original error is RETHROWN — such failures never masquerade as script errors in `_`.
 */
export function matchScriptError<
  const abi extends Abi | readonly unknown[],
  const handlers extends ScriptErrorHandlers<abi, unknown> & OnlyDeclaredHandlers<abi, handlers>,
>(script: { readonly abi: abi }, error: unknown, handlers: handlers): HandlerResult<handlers> {
  const decoded = decodeScriptError(script, error);
  if (decoded === undefined) {
    if (error instanceof Error) throw error;
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      'matchScriptError: the provided value carries no revert data (not a viem revert error or 0x-hex payload) — it was rethrown rather than routed to the "_" handler',
    );
  }
  const table = handlers as Readonly<Record<string, unknown>>;
  const decodedName: string = decoded.name;
  // Only a declared error has a handler of its name: an arm that carries `args` and is not one
  // of the two evs runtime errors. Every other arm goes to `_` even when the table has a key of
  // its name: a hand-built ABI can declare an error called 'empty' or 'unknown' (issue #62: its
  // handler would get an arm without args), and a table written without the types can hold a
  // `Panic` or `EvsDecodeError` key.
  const args = 'args' in decoded && !EVS_ERROR_NAMES.has(decodedName) ? decoded.args : undefined;
  // own handlers only: an error named like an Object.prototype member (`toString`, …) must not
  // dispatch to the inherited method
  const handler =
    args !== undefined && decodedName !== '_' && Object.hasOwn(table, decodedName)
      ? table[decodedName]
      : undefined;
  let result: unknown;
  if (typeof handler === 'function') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dispatch is keyed by the decoded name discriminant, so this IS that arm's handler
    result = (handler as (a: unknown, e: unknown) => unknown)(args, decoded);
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- no named handler matched, so decoded is in the `_` union by construction
    result = (handlers._ as (e: unknown) => unknown)(decoded);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dispatch is keyed by the decoded discriminant; the result is one handler's return by construction
  return result as HandlerResult<handlers>;
}
