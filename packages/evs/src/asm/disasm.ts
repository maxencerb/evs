/**
 * M4 `asm/disasm.ts` — the disassembler (architecture §14).
 *
 * Independent of the assembler: it consumes raw bytes (usable on foreign bytecode) and, when a
 * `SourceMap` is provided, annotates lines with labels, locs and notes. `assemble → disassemble`
 * round-trips byte-exactly: concatenating every line's `raw` reproduces the input.
 *
 * Bytes that are not a known evs opcode (e.g. inside data segments) disassemble as
 * `UNKNOWN_0x<byte>` with a 1-byte `raw`, keeping the byte-coverage invariant.
 */

import { bytesToHex, HEX_BYTES_RE, hexToBytes } from '../core/bytes.js';
import { EvsTypeError, type SourceLoc } from '../core/errors.js';
import type { Hex } from '../core/types.js';
import { OPS } from './ops.js';
import { lookupPc, type SourceMap } from './sourcemap.js';

export interface DisasmLine {
  pc: number;
  raw: Hex;
  mnemonic: string;
  pushValue?: Hex;
  targetLabel?: string;
  label?: string;
  loc?: SourceLoc | null;
  note?: string;
}

export interface Disassembly {
  readonly lines: readonly DisasmLine[];
  format(opts?: { locs?: boolean }): string;
}

const PUSH1_CODE = 0x60;
const PUSH32_CODE = 0x7f;

const MNEMONIC_BY_CODE: ReadonlyMap<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [name, info] of Object.entries(OPS)) {
    map.set(info.code, name);
  }
  return map;
})();

function toBytes(input: Hex | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (!HEX_BYTES_RE.test(input)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `disassemble: expected 0x-prefixed even-length hex bytecode, got ${JSON.stringify(input.length > 80 ? `${input.slice(0, 80)}…` : input)}`,
    );
  }
  return hexToBytes(input);
}

function formatLoc(loc: SourceLoc): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}

function formatLine(line: DisasmLine, withLocs: boolean): string {
  const pcHex = `0x${line.pc.toString(16).padStart(4, '0')}`;
  let text = `${pcHex}  ${line.raw.slice(2).padEnd(10)}  ${line.mnemonic}`;
  if (line.pushValue !== undefined) text += ` ${line.pushValue}`;
  if (line.targetLabel !== undefined) text += ` → @${line.targetLabel}`;
  const comment: string[] = [];
  if (line.note !== undefined) comment.push(line.note);
  if (withLocs && line.loc !== undefined && line.loc !== null) {
    comment.push(`— ${formatLoc(line.loc)}`);
  }
  if (comment.length > 0) text += `  ; ${comment.join(' ')}`;
  return text;
}

export function disassemble(bytecode: Hex | Uint8Array, sourceMap?: SourceMap): Disassembly {
  const bytes = toBytes(bytecode);

  const labelByPc = new Map<number, string>();
  if (sourceMap !== undefined) {
    for (const l of sourceMap.labels) labelByPc.set(l.pc, l.name);
  }

  const lines: DisasmLine[] = [];
  let pc = 0;
  while (pc < bytes.length) {
    const code = bytes[pc];
    if (code === undefined) break;

    let size = 1;
    let pushValue: Hex | undefined;
    let targetLabel: string | undefined;
    if (code >= PUSH1_CODE && code <= PUSH32_CODE) {
      const width = code - PUSH1_CODE + 1;
      const immEnd = Math.min(pc + 1 + width, bytes.length); // tolerate truncated trailing push
      pushValue = bytesToHex(bytes, pc + 1, immEnd);
      size = immEnd - pc;
      if (immEnd - (pc + 1) <= 6) {
        // small immediates may be label targets (PUSH2 fixups in practice)
        const value = Number.parseInt(pushValue.slice(2), 16);
        if (Number.isSafeInteger(value)) {
          const name = labelByPc.get(value);
          if (name !== undefined) targetLabel = name;
        }
      }
    }

    const known = MNEMONIC_BY_CODE.get(code);
    const line: DisasmLine = {
      pc,
      raw: bytesToHex(bytes, pc, pc + size),
      mnemonic: known ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`,
    };
    if (pushValue !== undefined) line.pushValue = pushValue;
    if (targetLabel !== undefined) line.targetLabel = targetLabel;
    const ownLabel = labelByPc.get(pc);
    if (ownLabel !== undefined) line.label = ownLabel;
    if (sourceMap !== undefined) {
      const hit = lookupPc(sourceMap, pc);
      if (hit !== undefined) {
        line.loc = hit.loc;
        if (hit.note !== undefined) line.note = hit.note;
      }
    }
    lines.push(line);
    pc += size;
  }

  return {
    lines,
    format(opts?: { locs?: boolean }): string {
      const withLocs = opts?.locs ?? true;
      const out: string[] = [];
      for (const line of lines) {
        if (line.label !== undefined) out.push(`@${line.label}:`);
        out.push(formatLine(line, withLocs));
      }
      return out.join('\n');
    },
  };
}
