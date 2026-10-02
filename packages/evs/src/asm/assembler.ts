/**
 * `asm/assembler.ts` — AsmNode stream, AsmWriter, and the two-pass assembler.
 *
 * - `pushLabel` is ALWAYS `PUSH2` + a big-endian fixup patched after layout (EIP-170/3860 keep
 *   every offset < 2^16, so PUSH2 always suffices and widths never shift).
 * - `push 0` lowers to `PUSH0` on shanghai+ and to `PUSH1 00` on paris; all other `push`
 *   values use the minimal-width PUSHn. The assembler owns immediate selection; codegen owns
 *   sequence-level lowering (MCOPY).
 * - `op` nodes never carry an immediate: a bare `PUSH1`..`PUSH32` op is rejected by both
 *   `AsmWriter.op` and `assemble()` (the latter also guards `peephole` hook output).
 * - A `push` node's `value` must be a bigint: `assemble()` rejects any other type (a `peephole`
 *   hook's number `0` would otherwise assemble to PUSH0 on every fork, paris included), and
 *   `CodeBuffer.minimalPush` refuses zero as a second line of defence.
 * - All `data`/`dataLabel` nodes are placed after the last code node, preceded by exactly one
 *   `INVALID` (0xFE) guard byte inserted here; codegen must still place them last in the node
 *   stream (asserted).
 * - An allocated label that is never placed is fine as long as no `pushLabel` names it (only
 *   fixups resolve labels); `AsmWriter.isReferenced` lets emitters skip unreferenced regions.
 * - Layout writes every node into one growable buffer, and the source map's segments are
 *   maximal runs of consecutive bytes sharing a note (a JUMPDEST's note is `@<label name>`).
 * - `verify: true` (default) runs the three passes from `asm/verify.ts`; failures are
 *   `EvsInternalError`s.
 */

import { EvsInternalError } from '../core/errors.js';
import {
  forkAtLeast,
  isTerminator,
  OPS,
  PUSH1_CODE,
  PUSH32_CODE,
  type EvmVersion,
  type Mnemonic,
} from './ops.js';
import type { SourceMap } from './sourcemap.js';
import { verifyJumpdests, verifyShapes, verifyStack } from './verify.js';

export type LabelId = number;

export type AsmNode =
  | { k: 'op'; op: Mnemonic; note?: string }
  | { k: 'push'; value: bigint; note?: string } // minimal-width; 0→PUSH0 (paris: PUSH1 00)
  | { k: 'pushBytes'; bytes: Uint8Array; note?: string } // exact-width PUSH<len>
  | { k: 'pushLabel'; label: LabelId; note?: string } // ALWAYS PUSH2 + fixup
  | { k: 'label'; label: LabelId; stack: number | 'any'; name?: string } // emits JUMPDEST
  | { k: 'dataLabel'; label: LabelId; name?: string } // no JUMPDEST
  | { k: 'data'; bytes: Uint8Array; note?: string };

interface NodeMeta {
  note?: string;
}

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `asm writer: ${message}`);
}

const TWO_POW_256 = 1n << 256n;

/** DUP mnemonics reachable from `returndatacopyAll({ dupDepth })` — index = dupDepth − 1. */
const SNAPSHOT_DUPS: readonly Mnemonic[] = [
  'DUP3',
  'DUP4',
  'DUP5',
  'DUP6',
  'DUP7',
  'DUP8',
  'DUP9',
  'DUP10',
  'DUP11',
  'DUP12',
  'DUP13',
  'DUP14',
  'DUP15',
  'DUP16',
];

/** Node kinds that carry a source-map `note` (every kind but the two label kinds). */
type NotedNode = Exclude<AsmNode, { k: 'label' | 'dataLabel' }>;

export class AsmWriter {
  #nodes: AsmNode[] = [];
  #nextLabel = 0;
  #names = new Map<LabelId, string>();
  /** Every label a `pushLabel` node has named so far — the only way a node references a label. */
  #referenced = new Set<LabelId>();
  /**
   * `#referenced` in insertion order (each label once, when first referenced): append-only, so a
   * {@link checkpoint} is its length and {@link rollback} un-references by truncating it.
   */
  #referencedLog: LabelId[] = [];

  newLabel(name?: string): LabelId {
    const id = this.#nextLabel;
    this.#nextLabel += 1;
    if (name !== undefined) this.#names.set(id, name);
    return id;
  }

  /** Appends `node`, attaching `note` only when present (`exactOptionalPropertyTypes`). */
  #append(node: NotedNode, note: string | undefined): void {
    if (note !== undefined) node.note = note;
    this.#nodes.push(node);
  }

  /** A label node's name: the one given at placement, else the one given at allocation. */
  #resolveName(label: LabelId, name: string | undefined): { name?: string } {
    const resolved = name ?? this.#names.get(label);
    return resolved === undefined ? {} : { name: resolved };
  }

  op(op: Mnemonic, meta?: NodeMeta): void {
    if (op.startsWith('PUSH')) {
      // PUSH immediates must go through push()/pushBytes()/pushLabel() so the assembler owns
      // width selection and the paris PUSH0 lowering; a bare PUSHn op would corrupt layout
      // (and a bare PUSH0 op would dodge the paris lowering).
      throw internal(`op('${op}') is not allowed — use push()/pushBytes()/pushLabel()`);
    }
    this.#append({ k: 'op', op }, meta?.note);
  }

  push(value: bigint | number, meta?: NodeMeta): void {
    let v: bigint;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw internal(`push(${value}) — number immediates must be safe integers`);
      }
      v = BigInt(value);
    } else {
      v = value;
    }
    if (v < 0n || v >= TWO_POW_256) {
      throw internal(`push value out of range [0, 2^256): ${v}`);
    }
    this.#append({ k: 'push', value: v }, meta?.note);
  }

  pushBytes(bytes: Uint8Array, meta?: NodeMeta): void {
    if (bytes.length < 1 || bytes.length > 32) {
      throw internal(`pushBytes length must be 1..32, got ${bytes.length}`);
    }
    this.#append({ k: 'pushBytes', bytes: bytes.slice() }, meta?.note);
  }

  pushLabel(label: LabelId, meta?: NodeMeta): void {
    if (!this.#referenced.has(label)) {
      this.#referenced.add(label);
      this.#referencedLog.push(label);
    }
    this.#append({ k: 'pushLabel', label }, meta?.note);
  }

  /**
   * Whether any `pushLabel` emitted so far references `label`. Emitters that place optional
   * regions last (the shared tails) use it to skip bodies nothing jumps to; the answer only
   * covers references already written, so query it after the last possible referencing code.
   */
  isReferenced(label: LabelId): boolean {
    return this.#referenced.has(label);
  }

  label(label: LabelId, stack: number | 'any', name?: string): void {
    this.#nodes.push({ k: 'label', label, stack, ...this.#resolveName(label, name) });
  }

  dataLabel(label: LabelId, name?: string): void {
    this.#nodes.push({ k: 'dataLabel', label, ...this.#resolveName(label, name) });
  }

  data(bytes: Uint8Array, note?: string): void {
    this.#append({ k: 'data', bytes: bytes.slice() }, note);
  }

  /**
   * The ONLY sanctioned RETURNDATACOPY emitter (the call shape invariant):
   * - `'zero'`          → `RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY` — the bubble path
   *   `(dest=0, offset=0, size=rds)`.
   * - `{ dupDepth: n }` → `RETURNDATASIZE PUSH0 DUP<n+2> RETURNDATACOPY` — the snapshot path
   *   `(dest=base, offset=0, size=rds)`, where the destination sits `n` deep on the stack
   *   before this sequence starts (1-based).
   *
   * Zero pushes are emitted as `push 0` nodes so the assembler's fork lowering applies
   * (PUSH0 on shanghai+, PUSH1 00 on paris); the shape verifier accepts both spellings.
   */
  returndatacopyAll(dst: 'zero' | { dupDepth: number }): void {
    this.op('RETURNDATASIZE');
    this.push(0n);
    if (dst === 'zero') {
      this.push(0n);
    } else {
      const n = dst.dupDepth;
      const dup = Number.isInteger(n) ? SNAPSHOT_DUPS[n - 1] : undefined;
      if (dup === undefined) {
        throw internal(
          `returndatacopyAll dupDepth must be an integer in 1..14 (DUP3..DUP16), got ${String(n)}`,
        );
      }
      this.op(dup);
    }
    this.op('RETURNDATACOPY');
  }

  nodes(): readonly AsmNode[] {
    return [...this.#nodes];
  }

  /**
   * @internal The number of nodes emitted so far, as a cheap position marker. Two equal marks
   * mean nothing was emitted in between (the lowering uses this to tell whether the last node
   * was a given store).
   */
  mark(): number {
    return this.#nodes.length;
  }

  /**
   * @internal Speculative emission (the array decoder's budget-driven path choice): a
   * checkpoint of the writer state — node count, label counter, referenced labels — that
   * {@link rollback} restores exactly, so code emitted and then discarded leaves no trace (no
   * label ids consumed, no shared tail marked referenced). O(1): every piece of that state only
   * grows between a checkpoint and its rollback, so three lengths are enough to undo it.
   */
  checkpoint(): WriterCheckpoint {
    return {
      nodes: this.#nodes.length,
      nextLabel: this.#nextLabel,
      referenced: this.#referencedLog.length,
    };
  }

  /** @internal Discards everything emitted since `cp` (see {@link checkpoint}). */
  rollback(cp: WriterCheckpoint): void {
    this.#nodes.length = cp.nodes;
    // label names are only ever set for a fresh id, so the ids allocated since `cp` are the
    // only names to drop
    for (let id = cp.nextLabel; id < this.#nextLabel; id++) this.#names.delete(id);
    this.#nextLabel = cp.nextLabel;
    for (let k = cp.referenced; k < this.#referencedLog.length; k++) {
      const label = this.#referencedLog[k];
      if (label !== undefined) this.#referenced.delete(label);
    }
    this.#referencedLog.length = cp.referenced;
  }

  /**
   * @internal The highest operand-stack height the nodes emitted since `cp` reach, simulated
   * linearly from `entryHeight` (the absolute height when `cp` was taken). Checked labels reset
   * the height to their annotation; code after a `TERMINATORS` op (JUMP included) is skipped until
   * the next label; `'any'` regions (failure stubs) are ignored — the same model as the
   * verifier's stack pass, restricted to one straight-line fragment.
   */
  peakHeightSince(cp: WriterCheckpoint, entryHeight: number): number {
    let height = entryHeight;
    let peak = entryHeight;
    let live = true;
    for (let k = cp.nodes; k < this.#nodes.length; k++) {
      const node = this.#nodes[k];
      if (node === undefined) break;
      if (node.k === 'label') {
        live = node.stack !== 'any';
        if (live && node.stack !== 'any') height = node.stack;
        continue;
      }
      if (!live) continue;
      if (node.k === 'push' || node.k === 'pushBytes' || node.k === 'pushLabel') {
        height += 1;
      } else if (node.k === 'op') {
        if (isTerminator(node.op)) {
          live = false;
          continue;
        }
        const info = OPS[node.op];
        height += info.pushes - info.pops;
      } else {
        continue;
      }
      if (height > peak) peak = height;
    }
    return peak;
  }
}

/**
 * @internal An {@link AsmWriter.checkpoint} snapshot: the lengths of the writer's append-only
 * state (nodes, label ids, first references), valid until an earlier checkpoint is rolled back.
 */
export interface WriterCheckpoint {
  readonly nodes: number;
  readonly nextLabel: number;
  readonly referenced: number;
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  evmVersion: EvmVersion;
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]; // default identity; runs before layout
  verify?: boolean; // default true
  /**
   * Called once the layout pass has fixed every pc (`totalLen` = final byte length), before any
   * label fixup is patched or any verifier runs. Throw from it to reject the program; `compile()`
   * enforces EIP-170 here, so an oversized program is reported as `COMPILE_LIMIT` rather than
   * tripping the PUSH2-reach assertion below (every label past 0xffff implies a runtime past
   * EIP-170's 24,576 bytes).
   */
  onLayout?: (totalLen: number, labelPcs: ReadonlyMap<LabelId, number>) => void;
}

export interface AssembleResult {
  bytecode: Uint8Array;
  sourceMap: SourceMap; // segments + labels only; sites merged by compile.ts
  labelPcs: ReadonlyMap<LabelId, number>;
}

function assembleError(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `assemble: ${message}`);
}

/**
 * The layout pass's output buffer: one byte array that doubles when full, written in place (no
 * per-node arrays to allocate and concatenate). Every node has a fixed width, so the final
 * length is known once the stream is laid out; {@link CodeBuffer.finish} trims to it. Exported
 * for the unit tests only (not re-exported from the package entry).
 */
export class CodeBuffer {
  #bytes: Uint8Array;
  /** Bytes written so far — the pc of the next byte. */
  pc = 0;

  constructor(capacity: number) {
    this.#bytes = new Uint8Array(Math.max(64, capacity));
  }

  #reserve(n: number): void {
    if (this.pc + n <= this.#bytes.length) return;
    let capacity = this.#bytes.length * 2;
    while (capacity < this.pc + n) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.pc));
    this.#bytes = grown;
  }

  byte(b: number): void {
    this.#reserve(1);
    this.#bytes[this.pc++] = b;
  }

  bytes(src: Uint8Array): void {
    this.#reserve(src.length);
    this.#bytes.set(src, this.pc);
    this.pc += src.length;
  }

  /** `PUSH<w>` + the minimal big-endian encoding of a non-zero `value` (`w` = its byte width). */
  minimalPush(value: bigint): void {
    let width = 0;
    for (let x = value; x > 0n; x >>= 8n) width += 1;
    // width 0 would write `PUSH1_CODE - 1` = PUSH0, whatever the fork: zero is the caller's case
    if (width === 0) throw assembleError(`minimalPush needs a non-zero value, got ${value}`);
    this.#reserve(1 + width);
    this.#bytes[this.pc++] = PUSH1_CODE + width - 1;
    let x = value;
    for (let i = this.pc + width - 1; i >= this.pc; i--) {
      this.#bytes[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.pc += width;
  }

  /** A copy of the bytes written, at their exact length. */
  finish(): Uint8Array {
    return this.#bytes.slice(0, this.pc);
  }
}

/**
 * The single byte an `op` node assembles to. The node stream can come from a user `peephole`
 * hook that never went through {@link AsmWriter.op}, so the immediate rule is re-checked here:
 * a bare `PUSH1`..`PUSH32` op would emit its opcode with no immediate, the EVM would then read
 * the following bytes as push data, and the bytecode would no longer match the node stream the
 * stack verifier simulates. A bare `PUSH0` stays legal: it has no immediate, and
 * `verifyShapes` gates it by fork.
 */
function opNodeCode(op: Mnemonic): number {
  const info = Object.hasOwn(OPS, op) ? OPS[op] : undefined;
  if (info === undefined) throw assembleError(`op node has unknown mnemonic '${op}'`);
  if (info.code >= PUSH1_CODE && info.code <= PUSH32_CODE) {
    throw assembleError(
      `op node '${op}' is not allowed — PUSH immediates must be push/pushBytes/pushLabel nodes`,
    );
  }
  return info.code;
}

interface Fixup {
  patchOffset: number; // offset of the first immediate byte of the PUSH2
  label: LabelId;
}

export function assemble(nodes: readonly AsmNode[], opts: AssembleOptions): AssembleResult {
  const peephole = opts.peephole ?? ((n: readonly AsmNode[]): AsmNode[] => [...n]);
  const stream = peephole(nodes);

  // data/dataLabel nodes must already sit after the last code node (codegen contract).
  let dataSeen = false;
  for (const node of stream) {
    const isData = node.k === 'data' || node.k === 'dataLabel';
    if (isData) {
      dataSeen = true;
    } else if (dataSeen) {
      throw assembleError(
        `${node.k} node appears after a data/dataLabel node — data segments must be last in the node stream`,
      );
    }
  }

  // single layout pass — every node has a fixed width (pushLabel is always PUSH2+2).
  const code = new CodeBuffer(stream.length * 2);
  const segments: { pc: number; len: number; note?: string }[] = [];
  const labels: { pc: number; name: string }[] = [];
  const labelPcs = new Map<LabelId, number>();
  const codeLabels = new Set<LabelId>();
  const fixups: Fixup[] = [];
  let dataStart = -1; // pc of the INVALID guard byte; -1 = no data segment

  // Records the bytes written since `start` under `note`. Segments are maximal same-note runs:
  // a node whose note matches the previous segment's extends it (`lookupPc` answers the same).
  const mark = (start: number, note: string | undefined): void => {
    const len = code.pc - start;
    if (len === 0) return;
    const last = segments.at(-1);
    if (last !== undefined && last.note === note) {
      last.len += len;
      return;
    }
    segments.push(note === undefined ? { pc: start, len } : { pc: start, len, note });
  };

  const defineLabel = (
    label: LabelId,
    at: number,
    name: string | undefined,
    kind: 'code' | 'data',
  ): void => {
    if (labelPcs.has(label)) throw assembleError(`label #${label} is defined twice`);
    labelPcs.set(label, at);
    if (kind === 'code') codeLabels.add(label);
    if (name !== undefined) labels.push({ pc: at, name });
  };

  for (const node of stream) {
    const start = code.pc;
    switch (node.k) {
      case 'op': {
        code.byte(opNodeCode(node.op));
        mark(start, node.note);
        break;
      }
      case 'push': {
        // a user `peephole` hook is not held to `value: bigint` (#98's rationale): a number `0`
        // would miss the `=== 0n` branch below and assemble to PUSH0 on every fork
        if (typeof node.value !== 'bigint') {
          throw assembleError(`push value must be a bigint, got ${typeof node.value}`);
        }
        if (node.value < 0n || node.value >= TWO_POW_256) {
          throw assembleError(`push value out of range [0, 2^256): ${node.value}`);
        }
        if (node.value === 0n) {
          // PUSH0 (shanghai+) | PUSH1 00 (paris)
          if (forkAtLeast(opts.evmVersion, OPS.PUSH0.since)) {
            code.byte(OPS.PUSH0.code);
          } else {
            code.byte(PUSH1_CODE);
            code.byte(0x00);
          }
        } else {
          code.minimalPush(node.value);
        }
        mark(start, node.note);
        break;
      }
      case 'pushBytes': {
        if (node.bytes.length < 1 || node.bytes.length > 32) {
          throw assembleError(`pushBytes length must be 1..32, got ${node.bytes.length}`);
        }
        code.byte(PUSH1_CODE + node.bytes.length - 1);
        code.bytes(node.bytes);
        mark(start, node.note);
        break;
      }
      case 'pushLabel': {
        fixups.push({ patchOffset: start + 1, label: node.label });
        code.byte(OPS.PUSH2.code);
        code.byte(0x00);
        code.byte(0x00);
        mark(start, node.note);
        break;
      }
      case 'label': {
        defineLabel(node.label, start, node.name, 'code');
        code.byte(OPS.JUMPDEST.code);
        mark(start, node.name === undefined ? undefined : `@${node.name}`);
        break;
      }
      case 'dataLabel':
      case 'data': {
        if (dataStart === -1) {
          dataStart = start;
          code.byte(OPS.INVALID.code);
          mark(start, 'data segment guard');
        }
        if (node.k === 'dataLabel') {
          defineLabel(node.label, code.pc, node.name, 'data');
        } else {
          const at = code.pc;
          code.bytes(node.bytes);
          mark(at, node.note);
        }
        break;
      }
    }
  }

  const totalLen = code.pc;
  if (dataStart === -1) dataStart = totalLen;
  opts.onLayout?.(totalLen, labelPcs);

  const bytecode = code.finish();

  // patch fixups big-endian
  const jumpTargets = new Set<number>();
  for (const { patchOffset, label } of fixups) {
    const target = labelPcs.get(label);
    if (target === undefined) {
      throw assembleError(`pushLabel references undefined label #${label}`);
    }
    if (target > 0xffff) {
      // assertion: compile() rejects anything over EIP-170 in `onLayout`, long before 0xffff
      throw assembleError(
        `label #${label} lands at pc 0x${target.toString(16)} > 0xffff — PUSH2 fixups cannot reach it`,
      );
    }
    bytecode[patchOffset] = (target >>> 8) & 0xff;
    bytecode[patchOffset + 1] = target & 0xff;
    if (codeLabels.has(label)) jumpTargets.add(target);
  }

  const sourceMap: SourceMap = {
    version: 1,
    segments,
    sites: [],
    labels,
  };

  if (opts.verify ?? true) {
    verifyJumpdests(bytecode, jumpTargets, dataStart);
    verifyStack(stream, labelPcs);
    verifyShapes(stream, { evmVersion: opts.evmVersion });
  }

  return { bytecode, sourceMap, labelPcs };
}
