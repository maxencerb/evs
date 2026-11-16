/**
 * `evm-target.ts` — a script's `evmVersion` against the chain it runs on.
 *
 * A build for `shanghai` or `cancun` uses opcodes an older chain, or an older block of the same
 * chain, does not have (`FORK_GATED_OPCODES`: `PUSH0`, `MCOPY`). Running it there fails in two
 * unrelated ways:
 *
 * - in deployless mode the script is a callee of viem's wrapper, so its frame dies without data
 *   and the wrapper reverts with nothing: an empty revert, which `explainRevert('0x')` explains
 *   (`explain.ts`, with the scan and the wording below);
 * - in state-override mode the script is the top frame, and the node answers with its own
 *   unsupported-opcode error (`invalid opcode: MCOPY`, `NotActivated`). That is not a revert, so
 *   `decodeScriptError` has nothing to decode: `explainUnsupportedOpcode` reads the node text.
 *
 * Part of the `@maxencerb/evs/runtime` entry, so it never reads the opcode table
 * (`runtime-graph.test.ts`): the few opcode facts it needs are restated below. They are here and
 * not in `asm/forks.ts` because that module loads with every precompiled script, while this one
 * is only reached by the explain code and by a client that imports `explainUnsupportedOpcode`.
 */

import { EVM_VERSIONS, PUSH0_FORK, type EvmVersion } from './asm/forks.js';
import { hexToBytes, isHexString } from './core/bytes.js';
import { errorTexts, EvsTypeError, lineAt } from './core/errors.js';
import type { Hex } from './core/types.js';

// ---------------------------------------------------------------------------
// the fork-gated opcodes of a runtime
// ---------------------------------------------------------------------------

/**
 * The opcodes newer than the `paris` floor that the compiler emits, newest fork first: what an
 * older `evmVersion` removes from a runtime, and what a node before that fork rejects. Each
 * entry restates its `OPS` row (`evm-target.test.ts` holds the two equal).
 */
export const FORK_GATED_OPCODES = [
  { mnemonic: 'MCOPY', code: 0x5e, since: 'cancun' },
  { mnemonic: 'PUSH0', code: 0x5f, since: PUSH0_FORK },
] as const satisfies readonly { mnemonic: string; code: number; since: EvmVersion }[];

export type ForkGatedOpcode = (typeof FORK_GATED_OPCODES)[number];

/** `PUSH1`…`PUSH32` carry 1…32 immediate bytes; `INVALID` is the assembler's guard before the
 *  data segments. The three codes of `asm/ops.ts` the scan needs (`evm-target.test.ts` holds
 *  them equal to the table). */
const PUSH1_CODE = 0x60;
const PUSH32_CODE = 0x7f;
const INVALID_CODE = 0xfe;

/**
 * The fork-gated opcodes the runtime's CODE region uses, newest fork first (the one most likely
 * to be missing at a historical block). The walk goes opcode by opcode, over each PUSH's
 * immediate, and ends at the first `INVALID`: the assembler plants one as the guard before the
 * data segments and the compiler emits it nowhere else, so everything after it is data, which is
 * never executed and does not count. (A user `peephole` hook that adds an `INVALID` of its own
 * only ends this scan early.)
 */
export function forkOpcodesOf(runtimeBytecode: Hex): readonly ForkGatedOpcode[] {
  const bytes = hexToBytes(runtimeBytecode);
  const used = new Set<number>();
  let pc = 0;
  while (pc < bytes.length) {
    const code = bytes[pc] ?? INVALID_CODE;
    if (code === INVALID_CODE) break;
    used.add(code);
    pc += 1 + (code >= PUSH1_CODE && code <= PUSH32_CODE ? code - PUSH1_CODE + 1 : 0);
  }
  return FORK_GATED_OPCODES.filter((opcode) => used.has(opcode.code));
}

/** "the runtime uses MCOPY (cancun) and PUSH0 (shanghai)": each opcode with the fork that
 *  introduced it (`opcodes` is non-empty). */
export function describeForkOpcodes(opcodes: readonly ForkGatedOpcode[]): string {
  return `the runtime uses ${opcodes.map((o) => `${o.mnemonic} (${o.since})`).join(' and ')}`;
}

/** The newest `evmVersion` older than `fork`: the target that drops what `fork` introduced. */
function targetBefore(fork: EvmVersion): EvmVersion {
  return EVM_VERSIONS[EVM_VERSIONS.indexOf(fork) - 1] ?? 'paris';
}

// ---------------------------------------------------------------------------
// the node's unsupported-opcode error → explanation
// ---------------------------------------------------------------------------

/** What {@link explainUnsupportedOpcode} recognized. */
export interface UnsupportedOpcodeExplanation {
  readonly kind: 'unsupported-opcode';
  /** What happened and what to do: recompile with `recompileWith`. */
  readonly message: string;
  /** The node's own text that matched, e.g. `invalid opcode: MCOPY`. */
  readonly nodeMessage: string;
  /** The opcode the node rejected, when its text names one (anvil's `NotActivated` does not). */
  readonly opcode?: 'MCOPY' | 'PUSH0';
  /** The newest `evmVersion` without the rejected opcode: `'shanghai'` for `MCOPY`, `'paris'`
   *  for `PUSH0`. When the node names no opcode, the newest one without any of the fork-gated
   *  opcodes the script uses. */
  readonly recompileWith: EvmVersion;
}

/**
 * A node's text for an opcode it does not have at the block it ran. geth and the nodes that reuse
 * its wording name the opcode (`invalid opcode: MCOPY`), or its byte when they do not know the
 * name (`invalid opcode: opcode 0x5e not defined`: the lookahead keeps that form's own word
 * `opcode` from reading as a name). revm-based nodes (anvil, reth) say `NotActivated`, which is
 * their error for exactly this (an opcode that exists but is not active in the running spec) and
 * names nothing.
 */
const UNSUPPORTED_OPCODE_RE =
  /\bopcode (?<code>0x[0-9a-f]{1,2}) not defined|\binvalid opcode: (?!opcode\b)(?<name>\w+)|\bNotActivated\b/i;

/** What a node text says it rejected: a fork-gated opcode, `'unnamed'`, or `'other'` (an opcode
 *  no `evmVersion` decides, such as `INVALID`). */
type Rejected = ForkGatedOpcode | 'unnamed' | 'other';

function rejectedBy(match: RegExpExecArray): Rejected {
  const { code, name } = match.groups ?? {};
  if (code === undefined && name === undefined) return 'unnamed';
  const found = FORK_GATED_OPCODES.find((opcode) =>
    code === undefined ? opcode.mnemonic === name?.toUpperCase() : opcode.code === Number(code),
  );
  return found ?? 'other';
}

/**
 * Recognizes a node's unsupported-opcode error in a caught error (or its message string) and
 * explains it against `script`: the chain, or the block the call is pinned to, is before the fork
 * the script was compiled for, and an older `evmVersion` fixes it. The whole `cause` chain is
 * searched (duck-typed, like `decodeScriptError`); viem shows these as "Missing or invalid
 * parameters" with the node text in `details`.
 *
 * It is the state-override form of the failure (and of any call that runs the script as the top
 * frame): in deployless mode the same cause is an empty revert, which `explainRevert('0x')`
 * explains. Returns `undefined` for anything else — rethrow it. That includes an opcode error
 * the script's target does not explain: the node names an opcode no `evmVersion` decides, or one
 * this runtime does not use.
 */
export function explainUnsupportedOpcode(
  script: { readonly runtimeBytecode: Hex },
  error: unknown,
): UnsupportedOpcodeExplanation | undefined {
  if (!isHexString(script.runtimeBytecode)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      'explainUnsupportedOpcode: `script.runtimeBytecode` must be 0x-prefixed even-length hex ' +
        '(pass the artifact or the precompiled script)',
    );
  }
  for (const text of errorTexts(error)) {
    const match = UNSUPPORTED_OPCODE_RE.exec(text);
    if (match === null) continue;
    const rejected = rejectedBy(match);
    const used = forkOpcodesOf(script.runtimeBytecode);
    const oldest = used.at(-1);
    if (rejected === 'other' || oldest === undefined) return undefined;
    if (rejected !== 'unnamed' && !used.includes(rejected)) return undefined;
    return describe(lineAt(text, match.index), rejected, used, oldest);
  }
  return undefined;
}

function describe(
  nodeMessage: string,
  rejected: ForkGatedOpcode | 'unnamed',
  used: readonly ForkGatedOpcode[],
  oldest: ForkGatedOpcode,
): UnsupportedOpcodeExplanation {
  const named = rejected === 'unnamed' ? undefined : rejected;
  // without a name, any of the opcodes in use may be the missing one: only the target older
  // than all of them is sure to run
  const recompileWith = targetBefore((named ?? oldest).since);
  const missing = named === undefined ? 'one of them' : named.mnemonic;
  const dropped = named === undefined ? used.map((o) => o.mnemonic).join(' and ') : named.mnemonic;
  const fix =
    recompileWith === 'paris'
      ? `recompile with evmVersion 'paris', which runs everywhere`
      : `recompile with evmVersion '${recompileWith}', the newest target without ${dropped} ` +
        `('paris' runs everywhere)`;
  return {
    kind: 'unsupported-opcode',
    nodeMessage,
    ...(named === undefined ? {} : { opcode: named.mnemonic }),
    recompileWith,
    message:
      `the node rejected an opcode of the script ("${nodeMessage}"): ` +
      `${describeForkOpcodes(used)}, and the chain does not have ${missing} at the block the ` +
      `call ran (the block is before that fork, or the chain never activated it) — ${fix}`,
  };
}
