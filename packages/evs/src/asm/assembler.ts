/**
 * M4 `asm/assembler.ts` — AsmNode stream, AsmWriter, and the two-pass assembler
 * (architecture §10).
 *
 * - `pushLabel` is ALWAYS `PUSH2` + a big-endian fixup patched after layout (EIP-170/3860 keep
 *   every offset < 2^16, so PUSH2 always suffices and widths never shift) [evm §3].
 * - `push 0` lowers to `PUSH0` on shanghai+ and to `PUSH1 00` on paris; all other `push`
 *   values use the minimal-width PUSHn. The assembler owns immediate selection; codegen owns
 *   sequence-level lowering (MCOPY).
 * - All `data`/`dataLabel` nodes are placed after the last code node, preceded by exactly one
 *   `INVALID` (0xFE) guard byte inserted here; codegen must still place them last in the node
 *   stream (asserted).
 * - `verify: true` (default) runs the three passes from `asm/verify.ts`; failures are
 *   `EvsInternalError`s.
 */

import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import { OPS, type EvmVersion, type Mnemonic } from './ops.js';
import type { SourceMap } from './sourcemap.js';
import { verifyJumpdests, verifyShapes, verifyStack } from './verify.js';

export type LabelId = number;

export type AsmNode =
  | { k: 'op'; op: Mnemonic; loc?: SourceLoc | null; note?: string }
  | { k: 'push'; value: bigint; loc?: SourceLoc | null; note?: string } // minimal-width; 0→PUSH0 (paris: PUSH1 00)
  | { k: 'pushBytes'; bytes: Uint8Array; loc?: SourceLoc | null; note?: string } // exact-width PUSH<len>
  | { k: 'pushLabel'; label: LabelId; loc?: SourceLoc | null; note?: string } // ALWAYS PUSH2 + fixup
  | { k: 'label'; label: LabelId; stack: number | 'any'; name?: string } // emits JUMPDEST
  | { k: 'dataLabel'; label: LabelId; name?: string } // no JUMPDEST
  | { k: 'data'; bytes: Uint8Array; note?: string };

interface NodeMeta {
  loc?: SourceLoc | null;
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

function metaProps(meta?: NodeMeta): NodeMeta {
  const m: NodeMeta = {};
  if (meta?.loc !== undefined) m.loc = meta.loc;
  if (meta?.note !== undefined) m.note = meta.note;
  return m;
}

export class AsmWriter {
  #nodes: AsmNode[] = [];
  #nextLabel = 0;
  #names = new Map<LabelId, string>();

  newLabel(name?: string): LabelId {
    const id = this.#nextLabel;
    this.#nextLabel += 1;
    if (name !== undefined) this.#names.set(id, name);
    return id;
  }

  op(op: Mnemonic, meta?: NodeMeta): void {
    if (op.startsWith('PUSH')) {
      // PUSH immediates must go through push()/pushBytes()/pushLabel() so the assembler owns
      // width selection and the paris PUSH0 lowering; a bare PUSHn op would corrupt layout
      // (and a bare PUSH0 op would dodge the paris lowering).
      throw internal(`op('${op}') is not allowed — use push()/pushBytes()/pushLabel()`);
    }
    this.#nodes.push({ k: 'op', op, ...metaProps(meta) });
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
    this.#nodes.push({ k: 'push', value: v, ...metaProps(meta) });
  }

  pushBytes(bytes: Uint8Array, meta?: NodeMeta): void {
    if (bytes.length < 1 || bytes.length > 32) {
      throw internal(`pushBytes length must be 1..32, got ${bytes.length}`);
    }
    this.#nodes.push({ k: 'pushBytes', bytes: bytes.slice(), ...metaProps(meta) });
  }

  pushLabel(label: LabelId, meta?: NodeMeta): void {
    this.#nodes.push({ k: 'pushLabel', label, ...metaProps(meta) });
  }

  label(label: LabelId, stack: number | 'any', name?: string): void {
    const resolved = name ?? this.#names.get(label);
    const node: AsmNode =
      resolved === undefined
        ? { k: 'label', label, stack }
        : { k: 'label', label, stack, name: resolved };
    this.#nodes.push(node);
  }

  dataLabel(label: LabelId, name?: string): void {
    const resolved = name ?? this.#names.get(label);
    const node: AsmNode =
      resolved === undefined
        ? { k: 'dataLabel', label }
        : { k: 'dataLabel', label, name: resolved };
    this.#nodes.push(node);
  }

  data(bytes: Uint8Array, note?: string): void {
    const node: AsmNode =
      note === undefined
        ? { k: 'data', bytes: bytes.slice() }
        : { k: 'data', bytes: bytes.slice(), note };
    this.#nodes.push(node);
  }

  /**
   * The ONLY sanctioned RETURNDATACOPY emitter (architecture §7 shape invariant):
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
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  evmVersion: EvmVersion;
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]; // default identity; runs before layout
  verify?: boolean; // default true
}

export interface AssembleResult {
  bytecode: Uint8Array;
  sourceMap: SourceMap; // segments + labels only; sites merged by compile.ts
  labelPcs: ReadonlyMap<LabelId, number>;
}

function assembleError(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `assemble: ${message}`);
}

/** Minimal big-endian byte encoding of a non-zero value. */
function minimalBytes(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
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
  const chunks: Uint8Array[] = [];
  const segments: { pc: number; len: number; loc: SourceLoc | null; note?: string }[] = [];
  const labels: { pc: number; name: string }[] = [];
  const labelPcs = new Map<LabelId, number>();
  const codeLabels = new Set<LabelId>();
  const dataLabels = new Set<LabelId>();
  const fixups: Fixup[] = [];
  let pc = 0;
  let dataStart = -1; // pc of the INVALID guard byte; -1 = no data segment

  const emit = (bytes: Uint8Array, meta?: { loc?: SourceLoc | null; note?: string }): void => {
    if (bytes.length === 0) return;
    chunks.push(bytes);
    const seg: { pc: number; len: number; loc: SourceLoc | null; note?: string } = {
      pc,
      len: bytes.length,
      loc: meta?.loc ?? null,
    };
    if (meta?.note !== undefined) seg.note = meta.note;
    segments.push(seg);
    pc += bytes.length;
  };

  const defineLabel = (
    label: LabelId,
    at: number,
    name: string | undefined,
    kind: 'code' | 'data',
  ): void => {
    if (labelPcs.has(label)) throw assembleError(`label #${label} is defined twice`);
    labelPcs.set(label, at);
    (kind === 'code' ? codeLabels : dataLabels).add(label);
    if (name !== undefined) labels.push({ pc: at, name });
  };

  for (const node of stream) {
    switch (node.k) {
      case 'op': {
        emit(Uint8Array.of(OPS[node.op].code), node);
        break;
      }
      case 'push': {
        if (node.value < 0n || node.value >= TWO_POW_256) {
          throw assembleError(`push value out of range [0, 2^256): ${node.value}`);
        }
        if (node.value === 0n) {
          // PUSH0 (shanghai+) | PUSH1 00 (paris)
          emit(
            opts.evmVersion === 'paris' ? Uint8Array.of(0x60, 0x00) : Uint8Array.of(OPS.PUSH0.code),
            node,
          );
        } else {
          const imm = minimalBytes(node.value);
          emit(Uint8Array.of(0x60 + imm.length - 1, ...imm), node);
        }
        break;
      }
      case 'pushBytes': {
        if (node.bytes.length < 1 || node.bytes.length > 32) {
          throw assembleError(`pushBytes length must be 1..32, got ${node.bytes.length}`);
        }
        emit(Uint8Array.of(0x60 + node.bytes.length - 1, ...node.bytes), node);
        break;
      }
      case 'pushLabel': {
        fixups.push({ patchOffset: pc + 1, label: node.label });
        emit(Uint8Array.of(0x61, 0x00, 0x00), node);
        break;
      }
      case 'label': {
        defineLabel(node.label, pc, node.name, 'code');
        emit(
          Uint8Array.of(OPS.JUMPDEST.code),
          node.name === undefined ? {} : { note: `@${node.name}` },
        );
        break;
      }
      case 'dataLabel':
      case 'data': {
        if (dataStart === -1) {
          dataStart = pc;
          emit(Uint8Array.of(OPS.INVALID.code), { note: 'data segment guard' });
        }
        if (node.k === 'dataLabel') {
          defineLabel(node.label, pc, node.name, 'data');
        } else {
          emit(node.bytes.slice(), node.note === undefined ? {} : { note: node.note });
        }
        break;
      }
    }
  }

  const totalLen = pc;
  if (dataStart === -1) dataStart = totalLen;

  const bytecode = new Uint8Array(totalLen);
  let off = 0;
  for (const chunk of chunks) {
    bytecode.set(chunk, off);
    off += chunk.length;
  }

  // patch fixups big-endian
  const jumpTargets = new Set<number>();
  for (const { patchOffset, label } of fixups) {
    const target = labelPcs.get(label);
    if (target === undefined) {
      throw assembleError(`pushLabel references undefined label #${label}`);
    }
    if (target > 0xffff) {
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
