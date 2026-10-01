/**
 * `codegen/sites.ts` — the SiteId table behind `explainRevert` / `EvsDecodeError`: one entry per
 * emitted statement (main body + the fns that were actually emitted), with its kind, a
 * human-readable detail that names the operands, and — on panic sites — the exact
 * `Panic(uint256)` codes the site can raise.
 *
 * `panicCodes` mirrors the templates in `lower/` (`lowerCheckedArith`, `lowerDivMod`, `lowerPow`,
 * `lowerModArith`, `lowerMulDiv`, `lowerConvert`, `lowerIndex` / `lowerArrset`, `lowerArrnew`): a site claims a
 * code iff its template can reach that panic tail at run time. A check the lowering elides (a
 * folded nonzero divisor, a folded base of 0 / ±1, a free widening, …) is never claimed, and
 * neither is the allocation check of a folded length below the cap, which can never fire. A
 * statement with no reachable panic is a `'stmt'` site. `sites.test.ts` pins every rule against
 * the panic tails the compiled bytecode actually references, so a lowering change that adds or
 * drops a check fails there until this table follows.
 *
 * Operands are named by what the user can see: a literal by its value, a recorded value by its
 * debug name (`args.x`, `s.read(token0)`, `s.newArray(uint256)`, …) and anything else by `#id`,
 * the value id an `Expr` handle prints (`Expr<uint256> #12`). A debug name several values share
 * (two `s.newArray(uint256)`, two reads of one function) gets that `#id` appended, so two sites
 * of the same kind on different operands get different details (the site id always differs).
 */

import type { SourceMap } from '../asm/sourcemap.js';
import { isNumeric, isSigned, type EvsType } from '../core/types.js';
import { walkStmts, type FnId, type Stmt, type ValueId } from '../ir/nodes.js';
import { fmtType } from './abi.js';
import { foldedConst, MINUS_ONE_WORD, MIN_I256, numClass, typeOf, type LowerCtx } from './lower.js';

type Site = SourceMap['sites'][number];
type SiteKind = Site['kind'];

/** The four codes evs itself raises (solc semantics). */
const OVERFLOW = 0x11;
const DIV_ZERO = 0x12;
const OUT_OF_BOUNDS = 0x32;
const ALLOC_TOO_LARGE = 0x41;

/** `lowerArrnew`'s length cap: a length above it panics 0x41. */
const ALLOC_CAP = 0xffffffffn;

export function collectSites(ctx: LowerCtx, emittedFns: readonly FnId[]): SourceMap['sites'] {
  const sites: Site[] = [];
  const seen = new Set<number>();
  const shared = sharedDebugNames(ctx);
  const add = (s: Stmt): void => {
    if (seen.has(s.site)) return;
    seen.add(s.site);
    sites.push(classifySite(ctx, shared, s));
  };
  walkStmts(ctx.ir.body, add);
  for (const f of emittedFns) {
    const fn = ctx.ir.fns[f];
    if (fn !== undefined) walkStmts(fn.body, add);
  }
  return sites;
}

function classifySite(ctx: LowerCtx, shared: ReadonlySet<string>, s: Stmt): Site {
  const site = (kind: SiteKind, detail: string): Site => ({ id: s.site, kind, detail });
  /** A panic site when `codes` is non-empty, else a plain statement with the same detail. */
  const checked = (what: string, codes: readonly number[]): Site =>
    codes.length === 0
      ? site('stmt', what)
      : {
          id: s.site,
          kind: 'panic',
          detail: `${what} — Panic ${codes.map(fmtCode).join('/')}`,
          panicCodes: Object.freeze([...codes]),
        };
  const op = (v: ValueId): string => describeOperand(ctx, shared, v);

  switch (s.k) {
    case 'call': {
      // explainRevert detail (issue #1): the STATICCALL (static) detail is kept verbatim; the new
      // CALL kinds prefix their verb so a simulate/call site is distinguishable in the message.
      const isStatic = s.kind === undefined || s.kind === 'static';
      const prefix = isStatic ? '' : `${s.kind} `;
      // revertReturns (issue #35): the strict site decodes the REVERT payload, and a normal return
      // lands on the same decode-fail stub — name the source so explainRevert reads right.
      const source = s.revertReturns === undefined ? 'returndata' : 'revert data';
      return s.mode === 'strict'
        ? site('decode', `decoding ${prefix}${s.fnAbi.name}() ${source}`)
        : site('call', `try ${prefix}${s.fnAbi.name}()`);
    }
    case 'bin': {
      const sym = BIN_SYMBOLS[s.op];
      if (sym === undefined) return site('stmt', `bin ${s.op}`);
      const type = typeOf(ctx, s.a);
      const what = `${s.op} ${op(s.a)} ${sym} ${op(s.b)} (${fmtType(type)})`;
      const codes = binPanicCodes(ctx, s, type);
      return codes.length > 0 ? checked(`checked ${what}`, codes) : site('stmt', what);
    }
    case 'modarith': {
      const what = `${s.op}(${op(s.a)}, ${op(s.b)}, ${op(s.n)})`;
      // lowerModArith / lowerMulDiv: the zero check unless the modulus / denominator is a folded
      // nonzero constant; muldiv/muldivup also overflow (0x11) when the quotient exceeds uint256
      const codes = zeroDivisorPossible(ctx, s.n) ? [DIV_ZERO] : [];
      if (s.op === 'muldiv' || s.op === 'muldivup') codes.push(OVERFLOW);
      return checked(what, codes);
    }
    case 'index':
      return checked(`array index ${op(s.arr)}[${op(s.i)}]`, [OUT_OF_BOUNDS]);
    case 'arrset':
      return checked(`array write ${op(s.arr)}[${op(s.i)}]`, [OUT_OF_BOUNDS]);
    case 'arrnew': {
      const length = foldedConst(ctx, s.length);
      const fits = length !== undefined && length <= ALLOC_CAP;
      const what = `array allocation ${op(s.out)} of length ${op(s.length)}`;
      return checked(what, fits ? [] : [ALLOC_TOO_LARGE]);
    }
    case 'convert': {
      const from = typeOf(ctx, s.a);
      const to = typeOf(ctx, s.out);
      const what = `conversion ${fmtType(from)} → ${fmtType(to)} of ${op(s.a)}`;
      return convertIsChecked(from, to)
        ? checked(`checked ${what}`, [OVERFLOW])
        : site('stmt', what);
    }
    default:
      return site('stmt', s.k);
  }
}

const BIN_SYMBOLS: Partial<Record<string, string>> = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
  mod: '%',
  pow: '**',
};

// ---------------------------------------------------------------------------
// panic codes — one rule per template in lower/ (see the module header)
// ---------------------------------------------------------------------------

function binPanicCodes(ctx: LowerCtx, s: Extract<Stmt, { k: 'bin' }>, type: EvsType): number[] {
  switch (s.op) {
    case 'add':
    case 'sub':
    case 'mul':
      // lowerCheckedArith: every width and signedness carries an overflow check
      return [OVERFLOW];
    case 'div':
    case 'mod': {
      // lowerDivMod: the zero check unless the divisor is a folded nonzero constant; the
      // overflow check (minN / −1) only for a SIGNED div whose divisor is not a folded constant
      // other than −1. Unsigned div/mod and signed mod never overflow.
      const codes = zeroDivisorPossible(ctx, s.b) ? [DIV_ZERO] : [];
      if (s.op === 'div' && numClass(type).signed) {
        const divisor = foldedConst(ctx, s.b);
        if (divisor === undefined || divisor === MINUS_ONE_WORD) codes.push(OVERFLOW);
      }
      return codes;
    }
    case 'pow': {
      // lowerPow: a folded base of 0, 1 or −1 and a folded exponent of 0 or 1 are check-free
      const base = foldedConst(ctx, s.a);
      if (base !== undefined) {
        const c = numClass(type).signed && base >= MIN_I256 ? base - (1n << 256n) : base;
        return c === 0n || c === 1n || c === -1n ? [] : [OVERFLOW];
      }
      const exponent = foldedConst(ctx, s.b);
      if (exponent !== undefined && exponent <= 1n) return [];
      return [OVERFLOW];
    }
    default:
      return [];
  }
}

/** The zero-divisor / zero-modulus check is elided only for a folded nonzero constant. */
function zeroDivisorPossible(ctx: LowerCtx, divisor: ValueId): boolean {
  const c = foldedConst(ctx, divisor);
  return c === undefined || c === 0n;
}

/**
 * lowerConvert: identity and `uint256` ↔ `bytes32` reinterprets are free, `asAddress` checks
 * the high 96 bits, a same-sign narrowing and `uintN → intM` with N ≥ M are range-checked,
 * same-sign widenings and `uintN → intM` with N < M are free, and `intN → uint*` always checks.
 */
function convertIsChecked(from: EvsType, to: EvsType): boolean {
  if (from === to) return false;
  if ((from === 'uint256' && to === 'bytes32') || (from === 'bytes32' && to === 'uint256')) {
    return false;
  }
  if (to === 'address') return true;
  const f = numClass(from);
  const t = numClass(to);
  if (f.signed === t.signed) return t.bits < f.bits;
  if (!f.signed) return f.bits >= t.bits;
  return true;
}

// ---------------------------------------------------------------------------
// operand rendering
// ---------------------------------------------------------------------------

function describeOperand(ctx: LowerCtx, shared: ReadonlySet<string>, v: ValueId): string {
  const c = foldedConst(ctx, v);
  if (c !== undefined) return describeLiteral(c, typeOf(ctx, v));
  const name = ctx.ir.values[v]?.debugName;
  if (name === undefined) return `#${v}`;
  return shared.has(name) ? `${name}#${v}` : name;
}

/** The debug names more than one value carries — rendered with their `#id` to stay unique. */
function sharedDebugNames(ctx: LowerCtx): ReadonlySet<string> {
  const once = new Set<string>();
  const shared = new Set<string>();
  for (const info of ctx.ir.values) {
    const name = info.debugName;
    if (name === undefined) continue;
    if (once.has(name)) shared.add(name);
    else once.add(name);
  }
  return shared;
}

/** A folded word constant as the user wrote it: signed decimal for intN, decimal for uintN,
 *  `true` / `false` for bool, hex for everything else (address, bytesN). */
function describeLiteral(word: bigint, type: EvsType): string {
  if (isNumeric(type)) {
    return isSigned(type) && word >= MIN_I256 ? String(word - (1n << 256n)) : String(word);
  }
  if (type === 'bool') return word === 0n ? 'false' : 'true';
  return `0x${word.toString(16)}`;
}

function fmtCode(code: number): string {
  return `0x${code.toString(16).padStart(2, '0')}`;
}
