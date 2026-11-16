/**
 * `debug-data.ts` — what the `debug` loader of a hydrated script resolved to, checked before
 * `explainRevert` reads it.
 *
 * The debug data is a second document, loaded apart from the script's data and, outside the
 * Vite plugin, paired with it by hand. Two things can be wrong with it:
 *
 * - its shape: it is parsed JSON or generated code, possibly written by another version of evs.
 *   Everything `explain.ts` reads is checked here, so a malformed document is a `TYPE_MISMATCH`
 *   and never an error thrown from inside an explanation;
 * - its origin: the debug data of another script, or of another build of this one, has the
 *   right shape and explains a revert with the wrong statements. `toPrecompiled()` writes one
 *   `id` into both documents (`compile.ts`), and the two are compared here.
 *
 * A client loads this module with the explain code (`explain.ts` re-exports it), on the first
 * `explainRevert()` or `debug()`: one that only hydrates carries none of these checks.
 *
 * It imports types only from `precompiled.ts`. That module loads up front, and a value imported
 * from it here would make bundlers move it, with what it imports, out of the chunk a client
 * loads first and into one shared with this code.
 */

import { EvsTypeError } from './core/errors.js';
import type { ScriptIr } from './ir/nodes.js';
import { siteKeysOf } from './ir/site-keys.js';
import type { PrecompiledScriptData, PrecompiledScriptDebug } from './precompiled.js';

const WHAT = 'the debug data of the precompiled script';

// The two versions this evs reads, typed by the shapes that declare them: a change there fails
// to compile here.
const FORMAT_VERSION: PrecompiledScriptDebug['version'] = 1;
const IR_VERSION: ScriptIr['irVersion'] = 1;

/** How every shape error ends: what the loader has to resolve to. */
const EXPECTED =
  "the `debug` loader must resolve to what the script's debug() returned at build time";

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null;
}

/**
 * The debug data in `loaded` (the data itself, or a module namespace whose `default` is the
 * data), checked: it has the shape `explainRevert` reads, and the compilation that wrote it is
 * the one that wrote `data`.
 */
export function debugDataOf(loaded: unknown, data: PrecompiledScriptData): PrecompiledScriptDebug {
  const debug = isObject(loaded) && 'default' in loaded ? loaded['default'] : loaded;
  assertDebug(debug);
  assertPaired(debug, data);
  return withSiteKeys(debug);
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/**
 * Everything `explain.ts` reads from the debug data: the script's name and argument types (the
 * signature it prints), the statement tree it walks for the call sites, and the sites. The rest
 * of the IR is not read and not checked.
 */
function assertDebug(debug: unknown): asserts debug is PrecompiledScriptDebug {
  if (!isObject(debug) || debug['version'] === undefined) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${WHAT} has no \`version\`: ${EXPECTED}, or to a module whose default export is that`,
    );
  }
  assertVersion(WHAT, debug['version'], FORMAT_VERSION);
  const { ir, sites } = debug;
  if (!isObject(ir) || !Array.isArray(sites)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${WHAT} must hold \`ir\` and \`sites\`: ${EXPECTED}`);
  }
  // an IR this evs cannot read is not a malformed one: it says which version wrote it
  if (ir['irVersion'] !== undefined) {
    assertVersion(`the IR in ${WHAT}`, ir['irVersion'], IR_VERSION);
  }
  const irIsRead =
    ir['irVersion'] === IR_VERSION &&
    typeof ir['name'] === 'string' &&
    every(ir['args'], (arg) => isObject(arg) && isType(arg['type'])) &&
    isBlock(ir['body']) &&
    every(ir['fns'], (fn) => isObject(fn) && isBlock(fn['body']));
  if (!irIsRead || !every(sites, isSite)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${WHAT} has a malformed \`${irIsRead ? 'sites' : 'ir'}\`: ${EXPECTED}`,
    );
  }
}

/** Throws unless `version`, read from the document `what` names, is the `expected` one. */
function assertVersion(what: string, version: unknown, expected: number): void {
  if (version === expected) return;
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `${what} has version ${JSON.stringify(version)} and this evs reads version ${expected}: ` +
      `another version of evs produced it, so it must be regenerated (compile the script again)`,
  );
}

/** Whether `list` is an array whose items all pass `test`. By index: a hole in the array is a
 *  missing item, which `Array.prototype.every` would skip. */
function every(list: unknown, test: (item: unknown) => boolean): boolean {
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) if (!test(list[i])) return false;
  return true;
}

/** A statement list, and the lists nested in it: what `walkStmts` goes through. */
function isBlock(block: unknown): boolean {
  return every(block, (stmt) => {
    if (!isObject(stmt) || typeof stmt['k'] !== 'string') return false;
    if (stmt['k'] === 'if') return isBlock(stmt['then']) && isBlock(stmt['else']);
    return stmt['k'] !== 'while' || (isBlock(stmt['header']) && isBlock(stmt['body']));
  });
}

/** An argument type: a type string, or a tuple with its components. */
function isType(type: unknown): boolean {
  return typeof type === 'string' || (isParam(type) && type['components'] !== undefined);
}

function isParam(param: unknown): param is Json {
  return (
    isObject(param) &&
    typeof param['type'] === 'string' &&
    (param['components'] === undefined || every(param['components'], isParam))
  );
}

/** A site as a checked document holds it: `key` may be missing ({@link withSiteKeys}). */
type LoadedSite = Omit<PrecompiledScriptDebug['sites'][number], 'key'> & {
  readonly key?: string;
};

function isSite(site: unknown): boolean {
  return (
    isObject(site) &&
    Number.isSafeInteger(site['id']) &&
    (site['key'] === undefined || typeof site['key'] === 'string') &&
    typeof site['kind'] === 'string' &&
    typeof site['detail'] === 'string' &&
    (site['panicCodes'] === undefined || every(site['panicCodes'], Number.isSafeInteger))
  );
}

/**
 * The debug data with a `key` on every site. evs 0.6.0 and earlier wrote sites without one;
 * the keys are a function of the recorded IR, which the document holds, so they are computed
 * here and such a document explains a revert like one written today.
 *
 * Computing them reads more of the IR than {@link assertDebug} checked (each statement's own
 * fields, the value table), so an IR that cannot be read is reported as the malformed document
 * it is. A site whose statement the IR does not hold gets a key made of its id.
 */
function withSiteKeys(debug: PrecompiledScriptDebug): PrecompiledScriptDebug {
  const sites: readonly LoadedSite[] = debug.sites;
  if (sites.every((site) => site.key !== undefined)) return debug;
  let keys: ReadonlyMap<number, string>;
  try {
    keys = siteKeysOf(debug.ir);
  } catch {
    throw new EvsTypeError('TYPE_MISMATCH', `${WHAT} has a malformed \`ir\`: ${EXPECTED}`);
  }
  // copies: the loaded document may be frozen, and it is the caller's
  const keyed: PrecompiledScriptDebug['sites'][number][] = [];
  for (const site of sites) {
    keyed.push({ ...site, key: site.key ?? keys.get(site.id) ?? `#${site.id}` });
  }
  return { ...debug, sites: keyed };
}

// ---------------------------------------------------------------------------
// origin
// ---------------------------------------------------------------------------

function describeId(id: string | undefined): string {
  return id === undefined ? 'no id (evs 0.5.0 wrote it)' : `id ${id}`;
}

/**
 * The two documents must come from one compilation: they carry the same `id`. Documents
 * written by evs 0.5.0 have none, and all they share is the script's name, which tells another
 * script apart but not another build. A document with an id never pairs with one without.
 */
function assertPaired(debug: PrecompiledScriptDebug, data: PrecompiledScriptData): void {
  const [entry] = data.abi;
  // `hydrate` has checked that the ABI starts with the script's function
  const script = isObject(entry) && typeof entry['name'] === 'string' ? entry['name'] : '';
  const sameScript = debug.ir.name === script;
  if (debug.id === data.id && (data.id !== undefined || sameScript)) return;
  const given = `the debug data given to the precompiled script \`${script}\``;
  const ids = `the debug data has ${describeId(debug.id)} and the script's data has ${describeId(data.id)}`;
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    sameScript
      ? `${given} was written by another compilation of it: ${ids}. One compilation writes ` +
          `both: regenerate the two in one run`
      : `${given} is the one of another script, \`${debug.ir.name}\`: ${ids}. Pass hydrate() ` +
          `a \`debug\` loader of the debug data written with this script's data`,
  );
}
