/**
 * `deployless.ts` — the contract-creation limits of the default `toViem()` mode.
 *
 * A deployless call is a `to`-less `eth_call`, so the node runs it as a contract creation.
 * viem builds its data as `deploylessCallViaBytecodeBytecode ++ abi.encode(code, calldata)`: a
 * 398-byte wrapper whose constructor CREATE2s the script's `initBytecode`, calls it with the
 * calldata, and RETURNs the script's raw returndata as the wrapper's own deployed code. Three
 * creation rules therefore apply to every deployless call, none of which binds in
 * state-override mode (a plain CALL):
 *
 * - EIP-3860: the creation data (wrapper + encoded `initBytecode` + encoded calldata) must fit
 *   {@link DEPLOYLESS_MAX_DATA_BYTES} — so the script's ARGS count against it;
 * - EIP-170: the returndata, deposited as code, must fit {@link DEPLOYLESS_MAX_RESULT_BYTES};
 * - EIP-3541: deposited code must not start with byte `0xEF` — so a result whose first byte is
 *   `0xEF` fails (a static result whose first word is a `bytesN`, `uint256` or `int256`).
 *
 * This module holds the three answers evs gives: compile-time diagnostics for what the result
 * shape already decides (`deploylessResultDiagnostics`, forwarded by `compile()`), a pure size
 * helper for the args side (`deploylessDataSize`), and `explainDeploylessError`, which maps the
 * node's creation error (`max code size exceeded`, `CreateContractStartingWithEF`, … — viem often
 * shows only "Missing or invalid parameters") to an explanation.
 */

import { isDynamic, layoutOfType, staticSize, type TypeLayout } from './abi/layout.js';
import { HEX_BYTES_RE } from './core/bytes.js';
import { EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import {
  abiParamToType,
  elemTypeOf,
  isArrayValueType,
  isWordType,
  type EvsType,
  type Hex,
  type WordType,
} from './core/types.js';
import type { ScriptIr } from './ir/nodes.js';

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

/** EIP-170's code-size cap, applied in deployless mode to the script's raw returndata. */
export const DEPLOYLESS_MAX_RESULT_BYTES = 24_576;

/** EIP-3860's initcode cap, applied in deployless mode to viem's whole creation data
 *  ({@link deploylessDataSize}). */
export const DEPLOYLESS_MAX_DATA_BYTES = 49_152;

/** Byte length of viem's `deploylessCallViaBytecodeBytecode` (pinned against the installed
 *  viem by the unit tests; unchanged since viem added deployless calls). */
const VIEM_WRAPPER_BYTES = 398;

const pad32 = (bytes: number): number => Math.ceil(bytes / 32) * 32;

/**
 * The byte size of the creation data viem sends for a deployless call of `script` with
 * `calldata` (e.g. `encodeFunctionData({ abi, functionName, args })`): the 398-byte wrapper plus
 * `abi.encode(bytes initBytecode, bytes calldata)`. The call fails with "max initcode size
 * exceeded" when this is over {@link DEPLOYLESS_MAX_DATA_BYTES}; state-override mode has no such
 * cap. Pure arithmetic — nothing is sent.
 */
export function deploylessDataSize(script: { readonly initBytecode: Hex }, calldata: Hex): number {
  const init = hexByteLength(script.initBytecode, 'initBytecode');
  const data = hexByteLength(calldata, 'calldata');
  // abi.encode(bytes, bytes): two offset words, then each value as [length word][padded bytes]
  return VIEM_WRAPPER_BYTES + 4 * 32 + pad32(init) + pad32(data);
}

function hexByteLength(value: unknown, what: string): number {
  if (typeof value !== 'string' || !HEX_BYTES_RE.test(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `deploylessDataSize: \`${what}\` must be 0x-prefixed even-length hex`,
    );
  }
  return (value.length - 2) / 2;
}

// ---------------------------------------------------------------------------
// compile-time diagnostics (what the result shape already decides)
// ---------------------------------------------------------------------------

/**
 * `DEPLOYLESS_RESULT_PREFIX` and `DEPLOYLESS_RESULT_SIZE` for a script's return list. The
 * result is ONE tuple of the returned values: when any value is dynamic the encoding starts
 * with its offset word (`0x20`, never `0xEF`); when all are static the first leaf is inlined at
 * byte 0, and only a `bytesN`, `uint256` or `int256` word can start with `0xEF` (narrower ints
 * are zero- or sign-extended, `address`/`bool` zero-padded). The size check is exact for a
 * static result and a lower bound (every dynamic part empty) for a dynamic one.
 */
export function deploylessResultDiagnostics(returns: ScriptIr['returns']): EvsDiagnostic[] {
  const first = returns[0];
  if (first === undefined) return [];
  const layouts = returns.map((r) => layoutOfType(r.type));
  const dynamic = layouts.some(isDynamic);
  const diagnostics: EvsDiagnostic[] = [];

  const leading = dynamic ? undefined : leadingWord(first.type, first.name);
  if (leading !== undefined && mayStartWithEf(leading.type)) {
    diagnostics.push({
      severity: 'warning',
      code: 'DEPLOYLESS_RESULT_PREFIX',
      message:
        `the result starts with \`${leading.path}\` (${leading.type}) at byte 0: in the default ` +
        `deployless toViem() mode the result is deposited as contract code, which the node ` +
        `rejects when its first byte is 0xEF (EIP-3541) — a ${leading.type} value starting with ` +
        `0xEF (a hash 1 time in 256) fails the call; use toViem({ mode: 'stateOverride' }), or ` +
        `return an address, bool or narrower integer first, or any dynamic value`,
    });
  }

  const size = dynamic
    ? 32 + layouts.reduce((n, l) => n + headAndTail(l), 0)
    : layouts.reduce((n, l) => n + staticSize(l), 0);
  if (size > DEPLOYLESS_MAX_RESULT_BYTES) {
    diagnostics.push({
      severity: 'warning',
      code: 'DEPLOYLESS_RESULT_SIZE',
      message:
        `the result is ${dynamic ? 'at least' : 'always'} ${size} bytes — over the ` +
        `${DEPLOYLESS_MAX_RESULT_BYTES}-byte code-size cap (EIP-170) a deployless result is ` +
        `deposited under, so every call in the default deployless toViem() mode fails; use ` +
        `toViem({ mode: 'stateOverride' }) or return less`,
    });
  }
  return diagnostics;
}

/** The word at byte 0 of a STATIC value's encoding, with a readable path (`pos.amount[0]`). */
function leadingWord(type: EvsType, path: string): { type: WordType; path: string } | undefined {
  if (typeof type === 'string' && isWordType(type)) return { type, path };
  if (typeof type === 'object' && type.type === 'tuple') {
    const member = type.components[0];
    if (member === undefined) return undefined;
    const name = member.name === '' ? '0' : member.name;
    return leadingWord(abiParamToType(member), `${path}.${name}`);
  }
  // a static T[N]: element 0 (N ≥ 1 is a type invariant); string/bytes are dynamic, never here
  return isArrayValueType(type) ? leadingWord(elemTypeOf(type), `${path}[0]`) : undefined;
}

function mayStartWithEf(type: WordType): boolean {
  return type === 'uint256' || type === 'int256' || type.startsWith('bytes');
}

/** Encoded size of one value in a tuple: its inline static bytes, or its offset word plus the
 *  smallest tail it can have (empty strings and `T[]`s). */
function headAndTail(l: TypeLayout): number {
  return isDynamic(l) ? 32 + minTail(l) : staticSize(l);
}

function minTail(l: TypeLayout): number {
  if (!isDynamic(l)) return staticSize(l);
  if (l.kind === 'tuple') return l.components.reduce((n, c) => n + headAndTail(c), 0);
  // a dynamic T[N]: N element heads (+ their smallest tails); `string`/`bytes`/`T[]`: a length
  if (l.kind === 'array' && l.length !== null) return l.length * headAndTail(l.elem);
  return 32;
}

// ---------------------------------------------------------------------------
// node errors → explanation
// ---------------------------------------------------------------------------

/** What {@link explainDeploylessError} recognized. */
export interface DeploylessLimitExplanation {
  /** `result-starts-with-ef` (EIP-3541), `result-too-large` (EIP-170) or `data-too-large`
   *  (EIP-3860, args included). */
  readonly kind: 'result-starts-with-ef' | 'result-too-large' | 'data-too-large';
  /** What happened and what to do (always: `toViem({ mode: 'stateOverride' })` avoids it). */
  readonly message: string;
  /** The node's own text that matched, e.g. `max code size exceeded: code size 24608 limit 24576`. */
  readonly nodeMessage: string;
  /** The rejected size in bytes, when the node reported it (geth-style messages do). */
  readonly size?: number;
  /** The cap that was exceeded, for the two size kinds. */
  readonly limit?: number;
}

type LimitKind = DeploylessLimitExplanation['kind'];

/** The creation-failure texts of geth-derived nodes (geth, reth, erigon, …) and revm (anvil). */
const NODE_PATTERNS: readonly { kind: LimitKind; re: RegExp }[] = [
  {
    kind: 'result-starts-with-ef',
    re: /invalid code: must not begin with 0xef|CreateContractStartingWithEF/i,
  },
  { kind: 'data-too-large', re: /max initcode size exceeded|CreateInitCodeSizeLimit/i },
  { kind: 'result-too-large', re: /max code size exceeded|CreateContractSizeLimit/i },
];

const SIZE_RE = /code size (\d+) limit (\d+)/;

const FIX = `run the script with toViem({ mode: 'stateOverride' }), which is a plain call`;

/**
 * Recognizes a deployless-mode creation failure in a caught error (or its message string) and
 * explains it: the node rejected the call because the result starts with `0xEF`, the result is
 * over {@link DEPLOYLESS_MAX_RESULT_BYTES}, or the creation data (args included) is over
 * {@link DEPLOYLESS_MAX_DATA_BYTES}. viem usually surfaces these as "Missing or invalid
 * parameters" or "Transaction creation failed" with the node text in `details`; the whole
 * `cause` chain is searched (duck-typed, like `decodeScriptError`). Returns `undefined` for
 * anything else — rethrow it.
 */
export function explainDeploylessError(error: unknown): DeploylessLimitExplanation | undefined {
  for (const text of errorTexts(error)) {
    for (const { kind, re } of NODE_PATTERNS) {
      const match = re.exec(text);
      if (match === null) continue;
      const nodeMessage = nodeLine(text, match.index);
      const sizes = SIZE_RE.exec(nodeMessage);
      const size = sizes === null ? undefined : Number(sizes[1]);
      return describe(kind, nodeMessage, size);
    }
  }
  return undefined;
}

function describe(
  kind: LimitKind,
  nodeMessage: string,
  size: number | undefined,
): DeploylessLimitExplanation {
  const sized = size === undefined ? {} : { size };
  const bytes = size === undefined ? '' : ` (${size} bytes)`;
  switch (kind) {
    case 'result-starts-with-ef':
      return {
        kind,
        nodeMessage,
        message:
          `deployless call failed: the script's result starts with byte 0xEF, and in deployless ` +
          `mode (the toViem() default) viem's wrapper returns the result as contract code, which ` +
          `must not begin with 0xEF (EIP-3541) — ${FIX}, or return an address, bool, narrower ` +
          `integer or dynamic value first`,
      };
    case 'result-too-large':
      return {
        kind,
        nodeMessage,
        ...sized,
        limit: DEPLOYLESS_MAX_RESULT_BYTES,
        message:
          `deployless call failed: the script's result${bytes} is over the ` +
          `${DEPLOYLESS_MAX_RESULT_BYTES}-byte code-size cap (EIP-170), which applies because ` +
          `deployless mode (the toViem() default) returns the result as contract code — ${FIX}, ` +
          `or split the call`,
      };
    default:
      return {
        kind,
        nodeMessage,
        ...sized,
        limit: DEPLOYLESS_MAX_DATA_BYTES,
        message:
          `deployless call failed: the creation data viem sends${bytes} — its wrapper, the ` +
          `script's initBytecode and the encoded args — is over the ${DEPLOYLESS_MAX_DATA_BYTES}` +
          `-byte initcode cap (EIP-3860); check it up front with deploylessDataSize(), and ` +
          `${FIX}, or pass smaller args`,
      };
  }
}

/** The message-like strings of `input` and its `cause` chain (cycle-safe). */
function errorTexts(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  const texts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = input;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const e = current as { details?: unknown; shortMessage?: unknown; message?: unknown };
    for (const text of [e.details, e.shortMessage, e.message]) {
      if (typeof text === 'string') texts.push(text);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return texts;
}

/** The line of `text` holding the match, trimmed (viem messages are multi-line). */
function nodeLine(text: string, at: number): string {
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end === -1 ? undefined : end).trim();
}
