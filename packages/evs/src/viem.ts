/**
 * M9 `viem.ts` — the init-code wrapper and the two `toViem()` shapes
 * (architecture §12, docs/research/viem-integration.md §1/§2/§5).
 *
 * - viem's deployless `code` parameter expects CREATION bytecode — passing runtime bytecode
 *   fails SILENTLY (viem-integration §1.3, empirically verified). The artifact therefore only
 *   ever exposes creation bytecode under a key named `code`; the raw fields are named
 *   `runtimeBytecode` / `initBytecode` deliberately.
 * - The locked 10-byte wrapper is `61 RRRR 80 600A 5F 39 5F F3` (RRRR = runtime length,
 *   big-endian PUSH2 immediate). The paris variant swaps `5F` (PUSH0) for `3D`
 *   (RETURNDATASIZE — zero at the start of an init frame):
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
 *   code/storage/balance on any major chain (viem-integration §5.1).
 */

import type { Abi, AbiParameter, AbiParameterToPrimitiveType, Address } from 'abitype';
import { BaseError, ContractFunctionRevertedError, type StateOverride } from 'viem';

import {
  canonicalTypeSignature,
  decodeErrorArgsRecord,
  PANIC_MEANINGS,
  selectorOf,
} from './abi/artifact.js';
import type { EvmVersion } from './asm/ops.js';
import { bytesToBigInt, bytesToHex, HEX_BYTES_RE, hexToBytes, isHexString } from './core/bytes.js';
import { EvsCompileError, EvsTypeError } from './core/errors.js';
import { abiParamToType, type Hex } from './core/types.js';
import type { PlainAbiParam } from './ir/nodes.js';

// ---------------------------------------------------------------------------
// init wrapper (architecture §10/§12 — the locked 10-byte builder)
// ---------------------------------------------------------------------------

/** EIP-170 keeps runtimes ≤ 24,576, far below the PUSH2 immediate ceiling. */
const PUSH2_MAX = 0xffff;

const EVM_VERSIONS: ReadonlySet<string> = new Set(['paris', 'shanghai', 'cancun']);

function assertEvmVersion(evmVersion: string): void {
  if (!EVM_VERSIONS.has(evmVersion)) {
    throw new EvsCompileError(
      'EVM_VERSION',
      `unknown evmVersion ${JSON.stringify(evmVersion)} — expected 'paris', 'shanghai' or 'cancun'`,
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
  const zero = evmVersion === 'paris' ? '3d' : '5f';
  const len = runtimeLength.toString(16).padStart(4, '0');
  return `0x61${len}80600a${zero}39${zero}f3`;
}

/**
 * The shanghai/cancun wrapper template, `61 RRRR 80 600A 5F 39 5F F3`, with the PUSH2 runtime
 * length `RRRR` (bytes 1–2) zeroed — `toCreationBytecode` patches the real length in. Exposed
 * for golden tests and inspection; prepending it verbatim only round-trips a 0-byte runtime.
 */
export const INIT_CODE_PREFIX_SHANGHAI: Hex = initWrapper(0, 'shanghai');

/**
 * `initBytecode = wrapper(len) ++ runtime` (architecture §12). The wrapper CODECOPYs
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
// toViem shapes (viem-integration §5)
// ---------------------------------------------------------------------------

/**
 * Default script address for state-override mode: last 20 bytes of keccak256("evs.script").
 * No code/storage/balance on any major chain; replaceable per call.
 */
export const DEFAULT_SCRIPT_ADDRESS: Address = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530';

/**
 * Deployless mode — maximum RPC compatibility: a plain 2-parameter `eth_call` with `to`
 * omitted. Spread the result into `readContract` (`code` must be CREATION bytecode — this is
 * why the input field is named `initBytecode`).
 */
export function toViemDeployless<const abi extends Abi>(s: {
  abi: abi;
  initBytecode: Hex;
}): { abi: abi; code: Hex } {
  return { abi: s.abi, code: s.initBytecode };
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

const PANIC_SELECTOR = selectorOf('Panic', ['uint256']);
const ERROR_STRING_SELECTOR = selectorOf('Error', ['string']);
const ERROR_STRING_INPUTS: readonly PlainAbiParam[] = [{ name: 'reason', type: 'string' }];

/** One (untrusted) ABI parameter → a `PlainAbiParam` (`name` defaulted to '', recursive over
 *  `components`). A malformed entry degrades to an empty type string, which simply never
 *  matches a selector downstream — decode helpers never throw on foreign ABI shapes. */
function toPlainParam(p: unknown): PlainAbiParam {
  if (typeof p !== 'object' || p === null) return { name: '', type: '' };
  const o = p as { name?: unknown; type?: unknown; components?: unknown };
  const name = typeof o.name === 'string' ? o.name : '';
  const type = typeof o.type === 'string' ? o.type : '';
  if (Array.isArray(o.components)) {
    const comps: readonly unknown[] = o.components;
    return { name, type, components: comps.map(toPlainParam) };
  }
  return { name, type };
}

/** An ABI error entry's inputs, normalized to `PlainAbiParam`s. */
function plainInputsOf(entry: { inputs?: unknown }): readonly PlainAbiParam[] {
  if (!Array.isArray(entry.inputs)) return [];
  const inputs: readonly unknown[] = entry.inputs;
  return inputs.map(toPlainParam);
}

/**
 * Pulls the raw revert payload out of `input`: a `0x…` string is taken verbatim (raw revert
 * bytes); a viem error tree is walked for the revert carrier (`ContractFunctionRevertedError`
 * for contract actions, a hex `data` — possibly nested `{ data }` — for plain `call()` /
 * RPC-level errors). Returns `undefined` when no revert data exists — a transport failure or
 * non-viem throw is NOT a script error.
 */
function revertDataOf(input: unknown): Hex | undefined {
  if (typeof input === 'string') {
    return isHexString(input) ? input : undefined;
  }
  if (!(input instanceof BaseError)) return undefined;
  let sawRevert = false;
  let data: Hex | undefined;
  input.walk((e) => {
    if (e instanceof ContractFunctionRevertedError) {
      sawRevert = true;
      data ??= e.raw;
      return false; // keep scanning — an outer wrapper may hide a richer carrier deeper
    }
    if (typeof e === 'object' && e !== null && 'data' in e) {
      const d: unknown = (e as { data: unknown }).data;
      if (typeof d === 'string') {
        if (isHexString(d)) {
          sawRevert = true;
          data ??= d;
        }
      } else if (typeof d === 'object' && d !== null && 'data' in d) {
        const dd: unknown = (d as { data: unknown }).data;
        if (typeof dd === 'string' && isHexString(dd)) {
          sawRevert = true;
          data ??= dd;
        }
      }
    }
    return false;
  });
  if (!sawRevert) return undefined;
  return data ?? '0x'; // a revert carrier with no payload = the empty revert
}

/**
 * Decodes a caught error (or raw revert bytes) against a script's ABI into a typed,
 * `name`-discriminated value (issue #15). Accepts the UNTOUCHED value from `catch` — the viem
 * error tree of `readContract`/`call` — or a `0x…` payload (e.g. `error.raw`,
 * `extractRevertData` output, stored bytes).
 *
 * Returns `undefined` when `input` carries NO revert data (network error, timeout, non-viem
 * throw): absence of revert data means "not a script error" — rethrow it, don't switch on it.
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

function decodeRevertData(abi: Abi | readonly unknown[], raw: Hex): DecodedScriptError {
  const bytes = hexToBytes(raw);
  if (bytes.length === 0) return { name: 'empty', raw: '0x' };
  if (bytes.length < 4) return { name: 'unknown', selector: raw, raw };
  const selector = bytesToHex(bytes.subarray(0, 4));
  const payload: Hex = `0x${raw.slice(2 + 8)}`;

  if (selector === PANIC_SELECTOR && bytes.length === 36) {
    const code = bytesToBigInt(bytes, 4);
    const codeHex = `0x${code.toString(16).padStart(2, '0')}`;
    return { name: 'Panic', code, meaning: PANIC_MEANINGS[codeHex] ?? 'unknown panic code', raw };
  }
  if (selector === ERROR_STRING_SELECTOR) {
    const decoded = decodeErrorArgsRecord(ERROR_STRING_INPUTS, payload);
    if (decoded !== null && typeof decoded['reason'] === 'string') {
      return { name: 'Error', reason: decoded['reason'], raw };
    }
  }
  if (Array.isArray(abi)) {
    for (const entry of abi as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { type?: unknown; name?: unknown; inputs?: unknown };
      if (e.type !== 'error' || typeof e.name !== 'string') continue;
      const inputs = plainInputsOf(e);
      const entrySelector = selectorOf(
        e.name,
        inputs.map((p) => canonicalTypeSignature(abiParamToType(p))),
      );
      if (entrySelector !== selector) continue;
      const args = decodeErrorArgsRecord(inputs, payload);
      if (args === null) break; // recognized selector, malformed payload → 'unknown'
      return { name: e.name, args, raw };
    }
  }
  return { name: 'unknown', selector, raw };
}

/** The error names `matchScriptError` REQUIRES a handler for: every script-ABI error except
 *  the evs built-ins (those — like Panic/Error/unknown/empty — flow to the `_` default arm,
 *  though an explicit handler for them is honored if provided). */
type DeclaredNames<abi> = Exclude<
  AbiErrorEntries<abi> extends infer e
    ? e extends { readonly name: infer n extends string }
      ? n
      : never
    : never,
  'EvsInvalidCalldata' | 'EvsDecodeError'
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
    error: Extract<DecodedScriptError<abi>, { readonly name: n }>,
  ) => r;
} & {
  readonly _: (error: Exclude<DecodedScriptError<abi>, { readonly name: DeclaredNames<abi> }>) => r;
};

/** The union of every handler's return type — {@link matchScriptError}'s result. */
export type HandlerResult<handlers> = {
  [k in keyof handlers]: handlers[k] extends (...args: never[]) => infer r ? r : never;
}[keyof handlers];

/**
 * Exhaustive switch over a script's error set (issue #15): decodes the caught error via
 * {@link decodeScriptError} and dispatches to the matching handler — declared errors receive
 * their typed args record; everything else (Panic, Error(string), the evs built-ins, unknown
 * selectors, the empty revert) lands in `_`.
 *
 * If the input carries NO revert data (transport failure, timeout, non-viem throw), the
 * original error is RETHROWN — such failures never masquerade as script errors in `_`.
 */
export function matchScriptError<
  const abi extends Abi | readonly unknown[],
  const handlers extends ScriptErrorHandlers<abi, unknown>,
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
  const handler = decodedName === '_' ? undefined : table[decodedName];
  let result: unknown;
  if (typeof handler === 'function') {
    const args = 'args' in decoded ? decoded.args : Object.freeze({});
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dispatch is keyed by the decoded name discriminant, so this IS that arm's handler
    result = (handler as (a: unknown, e: unknown) => unknown)(args, decoded);
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- no named handler matched, so decoded is in the `_` union by construction
    result = (handlers._ as (e: unknown) => unknown)(decoded);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dispatch is keyed by the decoded discriminant; the result is one handler's return by construction
  return result as HandlerResult<handlers>;
}

/**
 * State-override mode — deterministic `address(this)`, controllable `msg.sender` (via the
 * `account` call parameter). Spread the result into `readContract`; requires a provider
 * supporting the third `eth_call` parameter.
 */
export function toViemStateOverride<const abi extends Abi>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address },
): { abi: abi; address: Address; stateOverride: StateOverride } {
  const address = opts?.address ?? DEFAULT_SCRIPT_ADDRESS;
  return {
    abi: s.abi,
    address,
    stateOverride: [{ address, code: s.runtimeBytecode }],
  };
}
