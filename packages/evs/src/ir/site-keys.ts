/**
 * `ir/site-keys.ts` — the key of a statement: a string that names it by what it is, where its
 * site id names it by where it is.
 *
 * A site id is the statement's position among everything the recorder appended, so it moves
 * when any statement is added or removed before it, and when a release of evs records a builder
 * verb with one statement more or fewer. The key is what a user holds across those changes: the
 * filter of an acknowledged warning (`EvsDiagnostic.key`), the statement a revert was traced to
 * (`RevertExplanation.site.key`), an entry of `compiled.sourceMap.sites`.
 *
 * A key is `<fn>/<label>#<n>`:
 *
 * - `<label>` names the statement ({@link siteLabel});
 * - `<fn>/` is the name of the `s.fn` whose body holds it, absent in the script body;
 * - `<n>` counts the statements before it with the same label in the same function, in the
 *   order `walkStmts` visits them (a block statement, then the statements inside it).
 *
 * So only a statement with the same label, added or removed earlier in the same function, moves
 * a key. The keys are a function of the recorded IR alone: they are computed before dead-code
 * elimination and do not depend on a compile option.
 *
 * Compiler-free: the explain chunk of the runtime entry computes the keys of debug data that
 * was written without them (`debug-data.ts`).
 */

import { canonicalTypeSignature } from '../abi/artifact.js';
import { walkStmts, type ScriptIr, type SiteId, type Stmt } from './nodes.js';

/** The builder verb that records a `call` statement (`s.read`, `s.tryCall`, `s.simulate`, …). */
export function callVerb(s: Extract<Stmt, { k: 'call' }>): string {
  const base = s.kind === 'call' ? 'call' : s.kind === 'simulate' ? 'simulate' : 'read';
  return s.mode === 'try' ? `s.try${base[0]?.toUpperCase() ?? ''}${base.slice(1)}` : `s.${base}`;
}

const ACCOUNT_VERBS = {
  balance: 's.balance',
  codesize: 's.codeSize',
  codehash: 's.codeHash',
} as const;

/**
 * The label of a statement: the part of its key ({@link siteKeysOf}) that says what it is.
 *
 * | Statement                      | Label                              | Example                  |
 * | ------------------------------ | ---------------------------------- | ------------------------ |
 * | `call`                         | the builder verb and the function  | `s.tryRead(balanceOf)`   |
 * | `fncall`                       | the name of the `s.fn`             | `quote()`                |
 * | `env`                          | `s.env` and what it reads          | `s.env(caller)`          |
 * | `account`                      | the builder verb                   | `s.balance`              |
 * | `throw`                        | `s.throw` and the error            | `s.throw(Stale)`         |
 * | `const`                        | `literal` and its type             | `literal(uint256)`       |
 * | `arrnew`                       | `array` and its type               | `array(address[])`       |
 * | `tuplenew`                     | `tuple` and its member types       | `tuple(uint112,uint112)` |
 * | `convert`                      | `convert` and the type it gives    | `convert(uint256)`       |
 * | `encode`                       | `encode` or `encodePacked`         | `encodePacked`           |
 * | `bin`, `un`, `modarith`        | the op                             | `add`                    |
 * | every other kind               | the kind                           | `cellget`                |
 *
 * It reads the statement and the tables of the IR, never a `debugName`: that text is for
 * display and changes freely.
 *
 * **These texts are public.** Users store keys in their filters, so a change to a label (a
 * rename, a new part, another type rendering) silences nothing and un-silences every warning
 * filtered on the old text: it is a breaking change, to be released and documented as one. A
 * new statement kind gets a label here and leaves the others alone. `site-keys.test.ts` pins
 * the whole table.
 */
export function siteLabel(s: Stmt, ir: ScriptIr): string {
  const typeOf = (value: number): string => {
    const type = ir.values[value]?.type;
    return type === undefined ? '?' : canonicalTypeSignature(type);
  };
  switch (s.k) {
    case 'call':
      return `${callVerb(s)}(${s.fnAbi.name})`;
    case 'fncall':
      return `${ir.fns[s.fn]?.name ?? `#${s.fn}`}()`;
    case 'env':
      return `s.env(${s.op})`;
    case 'account':
      return ACCOUNT_VERBS[s.op];
    case 'throw':
      return `s.throw(${ir.errors?.[s.error]?.name ?? `#${s.error}`})`;
    case 'const':
      return `literal(${canonicalTypeSignature(s.type)})`;
    case 'arrnew':
      return `array(${canonicalTypeSignature(s.elem)}[${s.fixed ?? ''}])`;
    case 'tuplenew': {
      // the signature of a tuple type is already parenthesized: `(uint112,uint112)`
      const type = typeOf(s.out);
      return type.startsWith('(') ? `tuple${type}` : `tuple(${type})`;
    }
    case 'convert':
      return `convert(${typeOf(s.out)})`;
    case 'encode':
      return s.mode === 'abi' ? 'encode' : 'encodePacked';
    case 'bin':
    case 'un':
    case 'modarith':
      return s.op;
    case 'select':
    case 'index':
    case 'len':
    case 'slice':
    case 'arrset':
    case 'field':
    case 'tupleset':
    case 'keccak256':
    case 'cellnew':
    case 'cellget':
    case 'cellset':
    case 'if':
    case 'while':
    case 'break':
    case 'continue':
      return s.k;
    default: {
      // compile-time exhaustiveness: a new Stmt kind fails tsc here until it has a label
      const unreachable: never = s;
      return String((unreachable as { k?: unknown }).k);
    }
  }
}

/**
 * The key of every statement of `ir` (the body and every `s.fn`, called or not), by site id.
 * `ir` must be the RECORDED IR: a pass that drops statements would shift the count of the ones
 * that stay.
 *
 * Unique within a script whatever the names in it: the count runs per rendered `<fn>/<label>`,
 * so two statements can only share a key by sharing that text and its count.
 */
export function siteKeysOf(ir: ScriptIr): ReadonlyMap<SiteId, string> {
  const keys = new Map<SiteId, string>();
  const counts = new Map<string, number>();
  const number = (scope: string, stmts: readonly Stmt[]): void => {
    walkStmts(stmts, (s) => {
      const named = scope + siteLabel(s, ir);
      const n = counts.get(named) ?? 0;
      counts.set(named, n + 1);
      keys.set(s.site, `${named}#${n}`);
    });
  };
  number('', ir.body);
  for (const fn of ir.fns) number(`${fn.name}/`, fn.body);
  return keys;
}
