/**
 * `codegen/peephole.ts` — the built-in peephole optimizer behind `compile({ optimize: true })`.
 *
 * A conservative, purely local rewrite pass over the `AsmNode` stream. It runs at the
 * `peephole` hook position — after lowering, BEFORE layout — so the mandatory verifiers in
 * `asm/verify.ts` (JUMPDEST scan, stack-height simulation, shape lints) and the EIP-170 check
 * always validate its output. Every rewrite below is provably semantics-preserving on its own:
 * same memory effects, same stack effect, same result words, same halting behavior.
 *
 * Rewrites (each documented at its matcher):
 *   1. store-then-reload   `PUSH s MSTORE PUSH s MLOAD`  → `DUP1 PUSH s MSTORE`
 *   2. reload-of-reload    `PUSH s MLOAD  PUSH s MLOAD`  → `PUSH s MLOAD DUP1`
 *   3. constant folding    `PUSH a PUSH b <binop>` / `PUSH a <unop>` → the folded immediate
 *   4. identities          `SWAPn SWAPn`, `DUPn POP`, `PUSH x POP`, `PUSH 0 ADD`, … → nothing
 *
 * Guard rails:
 * - A pattern element is only ever an `op` or a `push` node, so `label` (JUMPDEST),
 *   `dataLabel`, `data` and `pushLabel` nodes are barriers: no window spans a label boundary and
 *   no node carrying a label or jump target is ever rewritten.
 * - The three nodes before every `RETURNDATACOPY` (the sanctioned `[RETURNDATASIZE, PUSH0,
 *   (PUSH0|DUPn)]` window of `verifyShapes`) are protected from rewriting.
 * - Rewrite 1 raises the peak stack depth of its window by one; a checked-mode height
 *   simulation (the same one `verifyStack` runs) skips it where that would exceed the 16-item
 *   template budget.
 * - Source-map fidelity: replacement nodes inherit the `loc`/`note` of the group they replace
 *   (the surviving original nodes keep their own), so `asm/sourcemap.ts` segments still map
 *   every emitted byte to the statement that produced it.
 * - The pass iterates to a fixpoint with a hard round bound; each round is linear.
 */

import type { AsmNode } from '../asm/assembler.js';
import { OPS, type Mnemonic } from '../asm/ops.js';
import { MAX_TEMPLATE_DEPTH } from '../asm/verify.js';
import type { SourceLoc } from '../core/errors.js';

const TWO_POW_256 = 1n << 256n;
const TWO_POW_255 = 1n << 255n;
const MASK_256 = TWO_POW_256 - 1n;

/** Fixpoint bound. Every rewrite removes nodes or consumes an op, so this is never reached in
 *  practice; it exists so the pass is total by construction. */
const MAX_ROUNDS = 64;

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------

/**
 * The built-in peephole pass. Pure: never mutates the input nodes (surviving nodes are reused
 * by reference; replacement nodes are fresh). Safe to run on any verifier-clean stream,
 * including one already optimized (idempotent at the fixpoint).
 */
export function evsPeephole(nodes: readonly AsmNode[]): AsmNode[] {
  let stream: readonly AsmNode[] = nodes;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { out, changed } = rewriteOnce(stream);
    stream = out;
    if (!changed) break;
  }
  return [...stream];
}

// ---------------------------------------------------------------------------
// one round
// ---------------------------------------------------------------------------

type Meta = { loc?: SourceLoc | null; note?: string };

/**
 * A matched window: `len` input nodes starting at the cursor are replaced by `out`.
 * `outPeak` is the peak stack depth of the OUTPUT window relative to the entry height when it
 * exceeds the input window's peak (only rewrite 1 raises it: +2 vs +1); `null` means the
 * output never goes deeper than the input did, which the verifier already accepted.
 */
interface Match {
  len: number;
  out: readonly AsmNode[];
  outPeak: number | null;
}

function rewriteOnce(nodes: readonly AsmNode[]): { out: AsmNode[]; changed: boolean } {
  const heights = checkedHeights(nodes);
  const shielded = protectedIndices(nodes);
  const out: AsmNode[] = [];
  let changed = false;
  let i = 0;
  while (i < nodes.length) {
    const m = matchAt(nodes, i);
    if (m !== null && !overlapsProtected(shielded, i, m.len) && withinBudget(heights[i], m)) {
      out.push(...m.out);
      i += m.len;
      changed = true;
      continue;
    }
    const node = nodes[i];
    if (node !== undefined) out.push(node);
    i += 1;
  }
  return { out, changed };
}

function overlapsProtected(shielded: ReadonlySet<number>, start: number, len: number): boolean {
  for (let j = start; j < start + len; j++) if (shielded.has(j)) return true;
  return false;
}

/**
 * `height` is the checked-mode simulated depth before the window (`null` = unreachable code or
 * an `'any'` region, where `verifyStack` does not enforce the template budget). A match that
 * goes deeper than its input did must still fit the 16-item budget from that height.
 */
function withinBudget(height: number | null | undefined, m: Match): boolean {
  if (m.outPeak === null || height === null || height === undefined) return true;
  return height + m.outPeak <= MAX_TEMPLATE_DEPTH;
}

/** Indices of the sanctioned RETURNDATACOPY windows (`verifyShapes` (a)) plus the op itself. */
function protectedIndices(nodes: readonly AsmNode[]): ReadonlySet<number> {
  const shielded = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    if (isOp(nodes[i], 'RETURNDATACOPY')) {
      for (let j = Math.max(0, i - 3); j <= i; j++) shielded.add(j);
    }
  }
  return shielded;
}

/**
 * Checked-mode stack height before every node, mirroring `verifyStack`'s walk: `0` at the
 * program start, reset to the label annotation at every `label`, `null` while unreachable
 * (after JUMP/RETURN/REVERT/STOP/INVALID until the next label) and inside `'any'` regions.
 * Rewrites preserve every window's net stack effect, so heights computed on the round's input
 * stay exact for every later window of the same round.
 */
function checkedHeights(nodes: readonly AsmNode[]): (number | null)[] {
  const heights: (number | null)[] = nodes.map((): number | null => null);
  let mode: 'checked' | 'any' = 'checked';
  let height = 0;
  let reachable = true;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined) continue;
    heights[i] = reachable && mode === 'checked' ? height : null;
    switch (node.k) {
      case 'label': {
        reachable = true;
        if (node.stack === 'any') {
          mode = 'any';
          height = 0;
        } else {
          mode = 'checked';
          height = node.stack;
        }
        break;
      }
      case 'dataLabel':
      case 'data':
        break;
      case 'push':
      case 'pushBytes':
      case 'pushLabel': {
        if (reachable) height += 1;
        break;
      }
      case 'op': {
        if (!reachable) break;
        const info = OPS[node.op];
        switch (node.op) {
          case 'JUMP':
            height -= 1;
            reachable = false;
            break;
          case 'RETURN':
          case 'REVERT':
          case 'STOP':
          case 'INVALID':
            height -= info.pops;
            reachable = false;
            break;
          default:
            height += info.pushes - info.pops;
            break;
        }
        break;
      }
    }
  }
  return heights;
}

// ---------------------------------------------------------------------------
// matchers
// ---------------------------------------------------------------------------

function matchAt(nodes: readonly AsmNode[], i: number): Match | null {
  return (
    matchStoreThenReload(nodes, i) ??
    matchReloadOfReload(nodes, i) ??
    matchConstantFold(nodes, i) ??
    matchIdentity(nodes, i)
  );
}

/**
 * Rewrite 1 — store-then-reload of the same slot (the dominant `storeOut` → `loadOperand`
 * sequence between consecutive statement templates):
 *
 *   before: [v, …] PUSH s → [s, v, …] MSTORE → [ …]   PUSH s → [s, …] MLOAD → [v, …]
 *   after:  [v, …] DUP1   → [v, v, …] PUSH s → [s, v, v, …] MSTORE → [v, …]
 *
 * Memory: both store `v` at `s` (MSTORE writes the full 32-byte word that MLOAD reads back,
 * so the reloaded word IS `v`); the rewrite performs the same single store. Stack: both end
 * with `v` on top of the untouched remainder; net effect 0 either way. Peak depth is one
 * higher (`+2` vs `+1` above the entry height) — see `withinBudget`. Saves one PUSH + one
 * MLOAD (≥ 3 bytes, 6 gas) per occurrence. The DUP1 inherits the reload's `loc`/`note` (the
 * statement whose operand load it now performs); the store keeps its own nodes.
 */
function matchStoreThenReload(nodes: readonly AsmNode[], i: number): Match | null {
  const a = nodes[i];
  const b = nodes[i + 1];
  const c = nodes[i + 2];
  const d = nodes[i + 3];
  if (
    a === undefined ||
    c === undefined ||
    !isPush(a) ||
    !isOp(b, 'MSTORE') ||
    !isPush(c) ||
    !isOp(d, 'MLOAD') ||
    a.value !== c.value
  ) {
    return null;
  }
  const dup: AsmNode = { k: 'op', op: 'DUP1', ...inheritMeta([c, d, a, b]) };
  return { len: 4, out: [dup, a, b], outPeak: 2 };
}

/**
 * Rewrite 2 — reloading a slot that was just loaded (the same operand used twice in a row):
 *
 *   before: PUSH s MLOAD PUSH s MLOAD → [v, v, …]
 *   after:  PUSH s MLOAD DUP1         → [v, v, …]
 *
 * No memory write happens between the two loads, so the second word equals the first. Same
 * net stack effect and the same peak depth (+2). The DUP1 inherits the second load's meta.
 */
function matchReloadOfReload(nodes: readonly AsmNode[], i: number): Match | null {
  const a = nodes[i];
  const b = nodes[i + 1];
  const c = nodes[i + 2];
  const d = nodes[i + 3];
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    !isPush(a) ||
    !isOp(b, 'MLOAD') ||
    !isPush(c) ||
    !isOp(d, 'MLOAD') ||
    a.value !== c.value
  ) {
    return null;
  }
  const dup: AsmNode = { k: 'op', op: 'DUP1', ...inheritMeta([c, d]) };
  return { len: 4, out: [a, b, dup], outPeak: null };
}

/**
 * Rewrite 3 — constant folding of pure arithmetic/logic over immediates:
 *
 *   PUSH second PUSH top <binop>  → PUSH fold(binop, top, second)
 *   PUSH x <unop>                 → PUSH fold(unop, x)
 *
 * `top` is the later push (the EVM's first operand μs[0]); `second` the earlier one (μs[1]).
 * Every folder below implements the Yellow Paper semantics exactly, including 256-bit
 * wraparound and the EVM's division-by-zero convention (`DIV`/`MOD`/`SDIV`/`SMOD` by zero yield
 * 0 — no exception, so folding them is sound). Net stack effect −1 (binop) / 0 (unop), the same
 * as the input; peak depth can only shrink. Only `push` nodes take part (`pushBytes` is an
 * exact-width literal and `pushLabel` is a fixup — both left alone).
 *
 * Size guard: a fold is only applied when the folded immediate encodes in no more bytes than
 * the nodes it replaces. Without it, `PUSH4 sel PUSH1 0xe0 SHL` (8 bytes — the selector
 * left-alignment every call template emits) would become a 33-byte `PUSH32`. Gas can never
 * get worse (every PUSHn costs 3, PUSH0 2), so bytes are the only constraint.
 */
function matchConstantFold(nodes: readonly AsmNode[], i: number): Match | null {
  const a = nodes[i];
  if (a === undefined || !isPush(a)) return null;
  const b = nodes[i + 1];
  if (b === undefined) return null;
  if (isPush(b)) {
    const c = nodes[i + 2];
    if (c === undefined || c.k !== 'op') return null;
    const folded = foldBinary(c.op, b.value, a.value);
    if (folded === null) return null;
    if (pushWidth(folded, 'out') > pushWidth(a.value, 'in') + pushWidth(b.value, 'in') + 1) {
      return null;
    }
    return {
      len: 3,
      out: [{ k: 'push', value: folded, ...inheritMeta([a, b, c]) }],
      outPeak: null,
    };
  }
  if (b.k === 'op') {
    const folded = foldUnary(b.op, a.value);
    if (folded === null) return null;
    if (pushWidth(folded, 'out') > pushWidth(a.value, 'in') + 1) return null;
    return { len: 2, out: [{ k: 'push', value: folded, ...inheritMeta([a, b]) }], outPeak: null };
  }
  return null;
}

/**
 * Encoded byte width of a `push` node. The pass is fork-agnostic, so zero is counted
 * conservatively: 1 byte (PUSH0) when it is an INPUT being replaced, 2 bytes (paris `PUSH1 00`)
 * when it is the OUTPUT being introduced — a fold that passes the guard under these bounds
 * never grows the bytecode on any target.
 */
function pushWidth(value: bigint, role: 'in' | 'out'): number {
  if (value === 0n) return role === 'in' ? 1 : 2;
  return 1 + Math.ceil(value.toString(16).length / 2);
}

/**
 * Rewrite 4 — stack/arith identities. Each entry lists the sequence and why it is a no-op
 * (`x` is the word under the pattern, μs[0] the top of stack):
 *
 *   SWAPn SWAPn          → ∅   swapping the same pair twice
 *   DUPn POP             → ∅   pushing a copy and dropping it
 *   PUSH v POP           → ∅   pushing an immediate and dropping it (push/pushBytes only)
 *   x PUSH 0 ADD|OR|XOR  → x   x+0, x|0, x^0
 *   x PUSH 0 SHL|SHR|SAR → x   shift = μs[0] = 0
 *   x PUSH 1 MUL         → x   x·1
 *   x PUSH 2²⁵⁶−1 AND    → x   full mask
 *   NOT NOT              → ∅   involution
 *   ISZERO ISZERO ISZERO → ISZERO   (ISZERO∘ISZERO is the bool canonicalization, an idempotent
 *                                    map; three applications equal one)
 *   x PUSH 0 MUL|AND     → POP PUSH 0   x·0 = x&0 = 0 for every x (same node count, cheaper)
 *
 * Deliberately NOT folded — the immediate is μs[0], the FIRST operand of every non-commutative
 * op: `PUSH 0 SUB` (0 − x), `PUSH 1 DIV` (1 / x), `PUSH 1 EXP` (1ˣ); and anything with
 * `pushLabel`.
 */
function matchIdentity(nodes: readonly AsmNode[], i: number): Match | null {
  const a = nodes[i];
  const b = nodes[i + 1];
  if (a === undefined || b === undefined) return null;

  if (a.k === 'op' && b.k === 'op') {
    if (isSwap(a.op) && a.op === b.op) return drop(2);
    if (isDup(a.op) && b.op === 'POP') return drop(2);
    if (a.op === 'NOT' && b.op === 'NOT') return drop(2);
    if (a.op === 'ISZERO' && b.op === 'ISZERO' && isOp(nodes[i + 2], 'ISZERO')) {
      return { len: 3, out: [a], outPeak: null };
    }
    return null;
  }

  if ((a.k === 'push' || a.k === 'pushBytes') && isOp(b, 'POP')) return drop(2);

  if (isPush(a) && b.k === 'op') {
    const v = a.value;
    const op = b.op;
    if (v === 0n && (op === 'ADD' || op === 'OR' || op === 'XOR')) return drop(2);
    if (v === 0n && (op === 'SHL' || op === 'SHR' || op === 'SAR')) return drop(2);
    if (v === 1n && op === 'MUL') return drop(2);
    if (v === MASK_256 && op === 'AND') return drop(2);
    if (v === 0n && (op === 'MUL' || op === 'AND')) {
      const meta = inheritMeta([a, b]);
      return {
        len: 2,
        out: [
          { k: 'op', op: 'POP', ...meta },
          { k: 'push', value: 0n, ...meta },
        ],
        outPeak: null,
      };
    }
  }
  return null;
}

function drop(len: number): Match {
  return { len, out: [], outPeak: null };
}

// ---------------------------------------------------------------------------
// folders (Yellow Paper semantics; `top` = μs[0], `second` = μs[1])
// ---------------------------------------------------------------------------

function toSigned(word: bigint): bigint {
  return word >= TWO_POW_255 ? word - TWO_POW_256 : word;
}

function fromSigned(v: bigint): bigint {
  return ((v % TWO_POW_256) + TWO_POW_256) % TWO_POW_256;
}

function bool(b: boolean): bigint {
  return b ? 1n : 0n;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base & MASK_256;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) & MASK_256;
    b = (b * b) & MASK_256;
    e >>= 1n;
  }
  return result;
}

/** Returns the folded word, or `null` when `op` is not a foldable pure binary op. */
export function foldBinary(op: Mnemonic, top: bigint, second: bigint): bigint | null {
  switch (op) {
    case 'ADD':
      return (top + second) & MASK_256;
    case 'MUL':
      return (top * second) & MASK_256;
    case 'SUB':
      return (top - second) & MASK_256;
    case 'DIV':
      return second === 0n ? 0n : top / second;
    case 'SDIV': {
      if (second === 0n) return 0n;
      // BigInt division truncates toward zero, as SDIV does; −2²⁵⁵ / −1 wraps back to −2²⁵⁵
      return fromSigned(toSigned(top) / toSigned(second));
    }
    case 'MOD':
      return second === 0n ? 0n : top % second;
    case 'SMOD': {
      if (second === 0n) return 0n;
      // BigInt `%` takes the dividend's sign, as SMOD does
      return fromSigned(toSigned(top) % toSigned(second));
    }
    case 'EXP':
      return modPow(top, second);
    case 'SIGNEXTEND': {
      // top = byte index b, second = x: sign-extend x from bit 8·b+7
      if (top >= 31n) return second;
      const bit = 8n * top + 7n;
      const mask = (1n << (bit + 1n)) - 1n;
      const low = second & mask;
      return (second >> bit) & 1n ? low | (MASK_256 ^ mask) : low;
    }
    case 'LT':
      return bool(top < second);
    case 'GT':
      return bool(top > second);
    case 'SLT':
      return bool(toSigned(top) < toSigned(second));
    case 'SGT':
      return bool(toSigned(top) > toSigned(second));
    case 'EQ':
      return bool(top === second);
    case 'AND':
      return top & second;
    case 'OR':
      return top | second;
    case 'XOR':
      return top ^ second;
    case 'BYTE': {
      // top = index i (0 = most significant byte), second = x
      if (top >= 32n) return 0n;
      return (second >> (8n * (31n - top))) & 0xffn;
    }
    case 'SHL':
      return top >= 256n ? 0n : (second << top) & MASK_256;
    case 'SHR':
      return top >= 256n ? 0n : second >> top;
    case 'SAR': {
      const s = toSigned(second);
      if (top >= 256n) return s < 0n ? MASK_256 : 0n;
      return fromSigned(s >> top); // BigInt >> on negatives is arithmetic (floor), as SAR is
    }
    default:
      return null;
  }
}

/** Returns the folded word, or `null` when `op` is not a foldable pure unary op. */
export function foldUnary(op: Mnemonic, x: bigint): bigint | null {
  switch (op) {
    case 'ISZERO':
      return bool(x === 0n);
    case 'NOT':
      return x ^ MASK_256;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// node helpers
// ---------------------------------------------------------------------------

type PushNode = Extract<AsmNode, { k: 'push' }>;
type OpNode = Extract<AsmNode, { k: 'op' }>;

function isPush(node: AsmNode | undefined): node is PushNode {
  return node !== undefined && node.k === 'push';
}

function isOp(node: AsmNode | undefined, op: Mnemonic): node is OpNode {
  return node !== undefined && node.k === 'op' && node.op === op;
}

const SWAP_RE = /^SWAP(?:[1-9]|1[0-6])$/;
const DUP_RE = /^DUP(?:[1-9]|1[0-6])$/;

function isSwap(op: Mnemonic): boolean {
  return SWAP_RE.test(op);
}

function isDup(op: Mnemonic): boolean {
  return DUP_RE.test(op);
}

/**
 * The `loc`/`note` a replacement node inherits: the first node (in the given priority order)
 * that carries a defined `loc`, and independently the first that carries a `note`. Props are
 * only set when present (`exactOptionalPropertyTypes`).
 */
function inheritMeta(from: readonly (AsmNode | undefined)[]): Meta {
  const meta: Meta = {};
  for (const node of from) {
    if (node === undefined || node.k === 'label' || node.k === 'dataLabel' || node.k === 'data') {
      continue;
    }
    if (meta.loc === undefined && node.loc !== undefined) meta.loc = node.loc;
    if (meta.note === undefined && node.note !== undefined) meta.note = node.note;
  }
  return meta;
}
