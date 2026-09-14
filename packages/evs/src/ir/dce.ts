/**
 * `ir/dce.ts` — dead-code elimination over a `ScriptIr` (issue #40).
 *
 * `compile()` runs this pass on every compile, between `validateIr` and `lowerProgram`, and it
 * is also exported (`eliminateDeadCode` / `dce`) so tools can apply it to an artifact's IR.
 * It removes statements whose only effect is to produce values nothing observable reads. The
 * value / cell / fn tables and every surviving statement (its `site`, `loc`, ValueIds) are
 * kept verbatim — statements are dropped, table entries are not — so source maps, diagnostics
 * and `explainRevert` keep resolving; `codegen/frame.ts` only allocates slots for values a
 * surviving statement defines, so the frame shrinks along with the program.
 *
 * Liveness (a backward sweep to a fixpoint over the whole statement tree, fn bodies included):
 *
 *   seeds  every `returns[].value`; every fn's params and `resultValues`; every `call` (any
 *          `kind`, `strict` or `try` — a sub-call is observable through gas and state, and its
 *          revert is the script's revert); every `throw`; every `while` (the loop may not
 *          terminate), `break` and `continue`; `fncall` to an IMPURE fn (see below).
 *   flow   a live statement makes every value it reads live; a live value makes its defining
 *          statement live, and every `arrset`/`tupleset` that mutates memory the value may
 *          alias (see aliasing); an `if` is live iff any statement in either branch is live
 *          (then its condition is live); everything else — `const`, `bin`, `un`, `env`,
 *          `convert`, `select`, `index`, `len`, `arrnew`, `arrset`, `tuplenew`, `field`,
 *          `tupleset`, `encode`, `keccak256`, `cellget`, and `fncall` to a pure fn — is pure
 *          and dropped when nothing live depends on it.
 *   cells  a cell is live iff a LIVE `cellget` of it exists anywhere (a `cellget` nobody reads
 *          is dead like any other pure statement; no per-position reasoning beyond that — loop
 *          back-edges make it a real dataflow problem for no payoff): its `cellnew` and every
 *          `cellset` then stay; a `set` on a never-read cell is dropped, `cellnew` included.
 *
 * Aliasing. Composite values have reference semantics (`index`/`field` hand back a pointer
 * into the parent, `tuplenew` inits and composite `arrset`/`tupleset` values are stored by
 * pointer, cells hold pointers, fn results may alias fn args), so a mutation reached through
 * one alias is visible through every other. The pass unions memref values that may share
 * memory (union-find; cells are pseudo-nodes) and keeps an `arrset`/`tupleset` iff ANY value
 * in its target's alias class is live — coarse but sound.
 *
 * Fn purity. A `fncall` whose outs are all dead is dropped iff the callee is pure: its body
 * (transitively) has no `call`, `throw`, `while`, impure `fncall`, or `arrset`/`tupleset` on
 * memory aliased with one of its params. Every other `fncall` stays live.
 *
 * REVERT GUARDS ARE NOT SIDE EFFECTS. Checked arithmetic (`bin` add/sub/mul/div/mod →
 * `Panic(0x11)`/`0x12`), narrowing `convert` (`Panic(0x21)`), bounds-checked `index`/`arrset`
 * (`Panic(0x32)`) and `arrnew` length guards (`Panic(0x41)`) can revert — but a revert that
 * only guarded a value nothing reads is itself dead work: a script that overflows while
 * computing an unused sum returns instead of panicking. This is the same rule the Solidity
 * optimizer applies to unused expressions, and it is what makes the pass an optimizer rather
 * than a no-op. Anything that must fail must feed a `throw`, a `call`, a return, or a live
 * cell. The differential suite checks `interpret(ir) == interpret(dce(ir)) == bytecode(dce(ir))`
 * on a corpus where no dead statement is the one that reverts.
 *
 * The pass is idempotent (`dce(dce(ir))` is `dce(ir)`, by identity when nothing changes) and
 * returns a deep-frozen IR that re-validates: `lowerProgram` runs `validateIr` on its output.
 */
/* oxlint-disable unicorn/no-thenable --
 * the IR schema names the if-statement branch field `then`. */

import { EvsInternalError } from '../core/errors.js';
import { isWordType } from '../core/types.js';
import {
  walkStmts,
  type CellId,
  type FnId,
  type FnIr,
  type ScriptIr,
  type Stmt,
  type ValueId,
} from './nodes.js';

/**
 * Removes the statements of `ir` whose results nothing observable depends on (see the module
 * doc for the liveness rules and the revert-guard decision). Expects a valid `ScriptIr`
 * (`validateIr`); `compile()` validates before and after. Returns `ir` itself when nothing is
 * dead, otherwise a deep-frozen copy sharing every surviving statement object and every table.
 */
export function eliminateDeadCode(ir: ScriptIr): ScriptIr {
  return new Dce(ir).run();
}

/** Alias of {@link eliminateDeadCode}. */
export const dce: (ir: ScriptIr) => ScriptIr = eliminateDeadCode;

// ---------------------------------------------------------------------------
// statement accessors
// ---------------------------------------------------------------------------

/** The ValueIds a statement reads (its own child blocks excluded — those are walked). */
function readsOf(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'env':
    case 'cellget':
    case 'break':
    case 'continue':
      return [];
    case 'bin':
      return [s.a, s.b];
    case 'un':
    case 'convert':
    case 'len':
    case 'keccak256':
      return [s.a];
    case 'select':
      return [s.cond, s.a, s.b];
    case 'index':
      return [s.arr, s.i];
    case 'arrnew':
      return [s.length];
    case 'arrset':
      return [s.arr, s.i, s.value];
    case 'tuplenew':
      return s.inits.map((init) => init.value);
    case 'field':
      return [s.tuple];
    case 'tupleset':
      return [s.tuple, s.value];
    case 'encode':
    case 'throw':
    case 'fncall':
      return s.args;
    case 'cellnew':
      return [s.init];
    case 'cellset':
      return [s.value];
    case 'call':
      return s.gas === undefined ? [s.target, ...s.args] : [s.target, ...s.args, s.gas];
    case 'if':
    case 'while':
      return [s.cond];
    default:
      return unreachable(s);
  }
}

/** The ValueIds a statement defines. */
function outsOf(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'bin':
    case 'un':
    case 'env':
    case 'convert':
    case 'select':
    case 'index':
    case 'len':
    case 'arrnew':
    case 'tuplenew':
    case 'field':
    case 'encode':
    case 'keccak256':
    case 'cellget':
      return [s.out];
    case 'call':
      return s.successOut === undefined ? s.outs : [...s.outs, s.successOut];
    case 'fncall':
      return s.outs;
    default:
      return [];
  }
}

function unreachable(s: never): never {
  const kind = String((s as { k?: unknown }).k);
  throw new EvsInternalError('INTERNAL', `dce: unknown statement kind '${kind}'`);
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

/** Every statement of a region with its parent block (for the `if` fixpoint and rebuild). */
interface Region {
  readonly stmts: readonly Stmt[];
  readonly params: readonly ValueId[]; // fn params (empty for the main body)
}

class Dce {
  private readonly ir: ScriptIr;
  /** union-find parent table over alias nodes: ValueId `v` → node `v`; CellId `c` → node `values.length + c` */
  private readonly parent: number[];
  private readonly defOf = new Map<ValueId, Stmt>();
  /** `arrset`/`tupleset` statements keyed by the alias-class root of their target */
  private readonly mutationsOf = new Map<number, Stmt[]>();
  /** `cellnew`/`cellset` statements per cell — enlivened together when the cell becomes live */
  private readonly cellWritesOf = new Map<CellId, Stmt[]>();
  private readonly liveCells = new Set<CellId>();
  private readonly liveStmts = new Set<Stmt>();
  private readonly liveValues = new Set<ValueId>();
  private readonly pureMemo = new Map<FnId, boolean>();
  private readonly visitingFns = new Set<FnId>();
  private readonly regions: Region[];
  private readonly allIfs: Stmt[] = [];

  constructor(ir: ScriptIr) {
    this.ir = ir;
    this.parent = Array.from({ length: ir.values.length + ir.cells.length }, (_, i) => i);
    this.regions = [
      { stmts: ir.body, params: [] },
      ...ir.fns.map((fn) => ({ stmts: fn.body, params: fn.params.map((p) => p.value) })),
    ];
  }

  run(): ScriptIr {
    this.index();
    this.seed();
    this.settleIfs();
    return this.rebuild();
  }

  // -------------------------------------------------------------------------
  // pass 1: defs, cell liveness, alias classes, mutation buckets
  // -------------------------------------------------------------------------

  private index(): void {
    for (const region of this.regions) {
      walkStmts(region.stmts, (s) => {
        for (const out of outsOf(s)) this.defOf.set(out, s);
        if (s.k === 'cellnew' || s.k === 'cellset') {
          const bucket = this.cellWritesOf.get(s.cell);
          if (bucket === undefined) this.cellWritesOf.set(s.cell, [s]);
          else bucket.push(s);
        }
        if (s.k === 'if') this.allIfs.push(s);
        this.unionAliases(s);
      });
    }
    // bucket mutations only once every union is known (roots are final)
    for (const region of this.regions) {
      walkStmts(region.stmts, (s) => {
        if (s.k !== 'arrset' && s.k !== 'tupleset') return;
        const root = this.find(s.k === 'arrset' ? s.arr : s.tuple);
        const bucket = this.mutationsOf.get(root);
        if (bucket === undefined) this.mutationsOf.set(root, [s]);
        else bucket.push(s);
      });
    }
  }

  private isMemref(v: ValueId): boolean {
    const info = this.ir.values[v];
    if (info === undefined) throw new EvsInternalError('INTERNAL', `dce: unknown ValueId ${v}`);
    return !isWordType(info.type);
  }

  private cellNode(c: CellId): number {
    return this.ir.values.length + c;
  }

  private find(node: number): number {
    let root = node;
    for (;;) {
      const p = this.parent[root];
      if (p === undefined)
        throw new EvsInternalError('INTERNAL', `dce: unknown alias node ${node}`);
      if (p === root) break;
      root = p;
    }
    // path compression
    let cur = node;
    while (cur !== root) {
      const next = this.parent[cur] ?? root;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  /** Memref values that may share memory after `s` runs (word values never alias). */
  private unionAliases(s: Stmt): void {
    switch (s.k) {
      case 'index':
        if (this.isMemref(s.out)) this.union(s.out, s.arr);
        return;
      case 'field':
        if (this.isMemref(s.out)) this.union(s.out, s.tuple);
        return;
      case 'select':
        if (this.isMemref(s.out)) {
          this.union(s.out, s.a);
          this.union(s.out, s.b);
        }
        return;
      case 'tuplenew':
        for (const init of s.inits) if (this.isMemref(init.value)) this.union(s.out, init.value);
        return;
      case 'arrset':
        if (this.isMemref(s.value)) this.union(s.arr, s.value);
        return;
      case 'tupleset':
        if (this.isMemref(s.value)) this.union(s.tuple, s.value);
        return;
      case 'cellnew':
        if (this.isMemref(s.init)) this.union(this.cellNode(s.cell), s.init);
        return;
      case 'cellset':
        if (this.isMemref(s.value)) this.union(this.cellNode(s.cell), s.value);
        return;
      case 'cellget':
        if (this.isMemref(s.out)) this.union(this.cellNode(s.cell), s.out);
        return;
      case 'fncall': {
        // a result may alias any arg (the callee may return a param or a view into one)
        const memrefs = [...s.args, ...s.outs].filter((v) => this.isMemref(v));
        const first = memrefs[0];
        if (first !== undefined) for (const v of memrefs) this.union(first, v);
        return;
      }
      default:
        return; // fresh allocations (const/arrnew/encode/call outs) and words
    }
  }

  // -------------------------------------------------------------------------
  // fn purity
  // -------------------------------------------------------------------------

  private isPureFn(f: FnId): boolean {
    const memo = this.pureMemo.get(f);
    if (memo !== undefined) return memo;
    const fn: FnIr | undefined = this.ir.fns[f];
    if (fn === undefined) throw new EvsInternalError('INTERNAL', `dce: unknown FnId ${f}`);
    if (this.visitingFns.has(f)) return false; // call-graph cycle (validateIr rejects it): impure
    this.visitingFns.add(f);
    const paramRoots = new Set(
      fn.params.filter((p) => this.isMemref(p.value)).map((p) => this.find(p.value)),
    );
    let pure = true;
    walkStmts(fn.body, (s) => {
      if (!pure) return;
      switch (s.k) {
        case 'call':
        case 'throw':
        case 'while':
        case 'break':
        case 'continue':
          pure = false;
          return;
        case 'fncall':
          if (!this.isPureFn(s.fn)) pure = false;
          return;
        case 'arrset':
        case 'tupleset':
          if (paramRoots.has(this.find(s.k === 'arrset' ? s.arr : s.tuple))) pure = false;
          return;
        default:
          return;
      }
    });
    this.visitingFns.delete(f);
    this.pureMemo.set(f, pure);
    return pure;
  }

  // -------------------------------------------------------------------------
  // pass 2: seeds + propagation (worklist to a fixpoint)
  // -------------------------------------------------------------------------

  private seed(): void {
    for (const r of this.ir.returns) this.markValue(r.value);
    for (const fn of this.ir.fns) {
      for (const p of fn.params) this.markValue(p.value);
      for (const rv of fn.resultValues) this.markValue(rv);
    }
    for (const region of this.regions) {
      walkStmts(region.stmts, (s) => {
        if (this.isSeed(s)) this.markStmt(s);
      });
    }
  }

  private isSeed(s: Stmt): boolean {
    switch (s.k) {
      case 'call':
      case 'throw':
      case 'while':
      case 'break':
      case 'continue':
        return true;
      case 'fncall':
        return !this.isPureFn(s.fn);
      default:
        return false; // cellnew/cellset follow their cell (markCell), never seed on their own
    }
  }

  /** A cell becomes live with its first live `cellget`; every write to it then stays. */
  private markCell(c: CellId): void {
    if (this.liveCells.has(c)) return;
    this.liveCells.add(c);
    for (const w of this.cellWritesOf.get(c) ?? []) this.markStmt(w);
  }

  private markValue(v: ValueId): void {
    if (this.liveValues.has(v)) return;
    this.liveValues.add(v);
    const def = this.defOf.get(v);
    if (def !== undefined) this.markStmt(def);
    if (this.isMemref(v)) {
      for (const m of this.mutationsOf.get(this.find(v)) ?? []) this.markStmt(m);
    }
  }

  private markStmt(s: Stmt): void {
    if (this.liveStmts.has(s)) return;
    this.liveStmts.add(s);
    if (s.k === 'cellget') this.markCell(s.cell);
    for (const v of readsOf(s)) this.markValue(v);
  }

  /** An `if` is live iff a statement in either branch is; marking one may enliven more. */
  private settleIfs(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of this.allIfs) {
        if (s.k !== 'if' || this.liveStmts.has(s)) continue;
        if (this.hasLiveStmt(s.then) || this.hasLiveStmt(s.else)) {
          this.markStmt(s);
          changed = true;
        }
      }
    }
  }

  private hasLiveStmt(stmts: readonly Stmt[]): boolean {
    let found = false;
    walkStmts(stmts, (s) => {
      if (this.liveStmts.has(s)) found = true;
    });
    return found;
  }

  // -------------------------------------------------------------------------
  // pass 3: rebuild (surviving statements are reused by identity)
  // -------------------------------------------------------------------------

  private rebuild(): ScriptIr {
    const { ir } = this;
    const body = this.rebuildBlock(ir.body);
    let fnsChanged = false;
    const fns = ir.fns.map((fn) => {
      const fnBody = this.rebuildBlock(fn.body);
      if (fnBody === fn.body) return fn;
      fnsChanged = true;
      return Object.freeze({ ...fn, body: fnBody });
    });
    if (body === ir.body && !fnsChanged) return ir;
    return Object.freeze({ ...ir, body, fns: Object.freeze(fns) });
  }

  private rebuildBlock(stmts: readonly Stmt[]): readonly Stmt[] {
    const out: Stmt[] = [];
    let changed = false;
    for (const s of stmts) {
      if (!this.liveStmts.has(s)) {
        changed = true;
        continue;
      }
      const kept = this.rebuildStmt(s);
      if (kept !== s) changed = true;
      out.push(kept);
    }
    return changed ? Object.freeze(out) : stmts;
  }

  private rebuildStmt(s: Stmt): Stmt {
    switch (s.k) {
      case 'if': {
        const then = this.rebuildBlock(s.then);
        const otherwise = this.rebuildBlock(s.else);
        if (then === s.then && otherwise === s.else) return s;
        return Object.freeze({ ...s, then, else: otherwise });
      }
      case 'while': {
        const header = this.rebuildBlock(s.header);
        const body = this.rebuildBlock(s.body);
        if (header === s.header && body === s.body) return s;
        return Object.freeze({ ...s, header, body });
      }
      default:
        return s;
    }
  }
}
