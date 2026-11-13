/**
 * `precompiled-module.ts` — the code that replaces a build-time module: its exports, written
 * out as values.
 *
 * A precompiled script becomes a `hydrate(...)` call on its data, plain data becomes a literal,
 * and any other export is an error that says what to change.
 *
 * What the plugin knows of evs is its public surface, and nothing of the precompiled data: it
 * asks `@maxencerb/evs/runtime` whether a value is a precompiled script, writes it with
 * `JSON.stringify`, and leaves reading it to `hydrate`. Two more evs values are recognized, by
 * a method of their public API (a script by `compile`, a compiled script by `toPrecompiled`),
 * and only to give them an error that says what to add (`scriptProblem`).
 */

import { isPrecompiledScript, type PrecompiledScript } from '@maxencerb/evs/runtime';

import { debugModuleCode, debugModuleId, debugModuleSpecifier } from './debug-module.js';

export interface PrecompiledModule {
  /** The module's new source. */
  readonly code: string;
  /** How many precompiled scripts it exports. One exported under two names is one script. */
  readonly scripts: number;
  /** The debug modules its scripts import on demand: resolved id → source. */
  readonly debugModules: ReadonlyMap<string, string>;
}

/**
 * Writes the module that replaces the build-time module `file`, from what `file` exports.
 * Throws on an export that is neither a precompiled script nor plain data.
 */
export async function renderPrecompiledModule(
  file: string,
  exports: Readonly<Record<string, unknown>>,
): Promise<PrecompiledModule> {
  const scripts = await renderScripts(file, exports);

  // A local binding per value, so every export name works: `default`, a reserved word. A script
  // exported under two names has one binding: it is one object on the client, as it was here.
  const declarations: string[] = [];
  const declare = (expression: string): string => {
    const local = `_${declarations.length}`;
    declarations.push(`const ${local} = ${expression};`);
    return local;
  };
  const scriptLocals = new Map<RenderedScript, string>();
  const localOf = (name: string, value: unknown): string => {
    const script = scripts.get(value);
    if (script === undefined) return declare(toLiteral(value, name, []));
    const local = scriptLocals.get(script) ?? declare(script.expression);
    scriptLocals.set(script, local);
    return local;
  };
  const specifiers = Object.entries(exports).map(
    ([name, value]) => `${localOf(name, value)} as ${exportName(name)}`,
  );

  const lines = [
    ...(scripts.size > 0 ? [`import { hydrate } from '@maxencerb/evs/runtime';`] : []),
    ...declarations,
    specifiers.length > 0 ? `export { ${specifiers.join(', ')} };` : 'export {};',
  ];
  return {
    code: `${lines.join('\n')}\n`,
    scripts: scripts.size,
    debugModules: new Map(Array.from(scripts.values(), ({ debugModule }) => debugModule)),
  };
}

interface RenderedScript {
  /** The expression that evaluates to the script: a `hydrate(...)` call on its data. */
  readonly expression: string;
  /** The module its debug data is served from: `[id, source]`. */
  readonly debugModule: readonly [id: string, code: string];
}

/** Writes each precompiled script among `exports` once, whatever the number of its names. */
async function renderScripts(
  file: string,
  exports: Readonly<Record<string, unknown>>,
): Promise<ReadonlyMap<unknown, RenderedScript>> {
  // (the first name a script is exported under is the one its debug module is labelled with)
  const firstNames = new Map<PrecompiledScript, string>();
  for (const [name, value] of Object.entries(exports)) {
    if (isPrecompiledScript(value) && !firstNames.has(value)) firstNames.set(value, name);
  }
  return new Map(
    await Promise.all(
      Array.from(
        firstNames,
        async ([script, name]) => [script, await renderScript(file, name, script)] as const,
      ),
    ),
  );
}

async function renderScript(
  file: string,
  name: string,
  script: PrecompiledScript,
): Promise<RenderedScript> {
  const debugJson = JSON.stringify(await script.debug());
  const specifier = debugModuleSpecifier(file, name, debugJson);
  return {
    // PURE: a script the app never uses is dropped from the bundle, like any unused export
    expression:
      `/* @__PURE__ */ hydrate(${JSON.stringify(script)}, ` +
      `{ debug: () => import(${JSON.stringify(specifier)}) })`,
    debugModule: [debugModuleId(specifier), debugModuleCode(debugJson)],
  };
}

const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** An export name as `export { x as <name> }` takes it: an identifier, or a string literal. */
function exportName(name: string): string {
  return IDENTIFIER_NAME.test(name) ? name : JSON.stringify(name);
}

// ---------------------------------------------------------------------------
// plain data
// ---------------------------------------------------------------------------

/**
 * The JavaScript literal of a plain value: what JSON holds, plus `bigint` and `undefined`.
 * `path` names the value in an error (`config.fees[0]`). `parents` are the containers being
 * written, to stop on a circular reference.
 *
 * The literal evaluates to the value the module exported, or the value is refused. Nothing is
 * left out or turned into something close: a client would then run on other data than the
 * build did, without a word.
 */
function toLiteral(value: unknown, path: string, parents: readonly object[]): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value); // NaN and ±Infinity are expressions
    case 'bigint':
      return `${value}n`;
    case 'undefined':
      return 'undefined';
    case 'object':
      return value === null ? 'null' : toObjectLiteral(value, path, parents);
    case 'function':
      throw unsupported(path, A_FUNCTION);
    default:
      throw unsupported(path, notData(`a ${typeof value}`));
  }
}

function toObjectLiteral(value: object, path: string, parents: readonly object[]): string {
  if (parents.includes(value)) throw unsupported(path, notData('a circular reference'));
  const inside = [...parents, value];
  const prototype: unknown = Object.getPrototypeOf(value);

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw unsupported(path, notData(instanceOf(value)));
    return toArrayLiteral(value, path, inside);
  }

  const script = scriptProblem(value);
  if (script !== undefined) throw unsupported(path, script);
  if (prototype === null) throw unsupported(path, notData('an object without a prototype'));
  if (prototype !== Object.prototype) throw unsupported(path, notData(instanceOf(value)));

  const properties = Reflect.ownKeys(value).map((key) => {
    const member = memberPath(path, key);
    if (typeof key === 'symbol') throw unsupported(member, notData('a property with a symbol key'));
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw unsupported(member, notData('a property that is not enumerable'));
    }
    return `${propertyKey(key)}: ${toLiteral(Reflect.get(value, key), member, inside)}`;
  });
  return `{ ${properties.join(', ')} }`;
}

function toArrayLiteral(
  value: readonly unknown[],
  path: string,
  inside: readonly object[],
): string {
  const items = Array.from(value, (item, index) => {
    const member = `${path}[${index}]`;
    if (!Object.hasOwn(value, index)) throw unsupported(member, notData('a hole in an array'));
    return toLiteral(item, member, inside);
  });
  // `items` has the keys of an array literal, its indices and `length`: any other key of
  // `value` is a property that was added to the array
  const added = Reflect.ownKeys(value).find((key) => !Object.hasOwn(items, key));
  if (added !== undefined) {
    throw unsupported(memberPath(path, added), notData('a property added to an array'));
  }
  return `[${items.join(', ')}]`;
}

/** A property key of an object literal. `__proto__` is computed: written plainly, it would set
 *  the prototype instead of a property. */
function propertyKey(key: string): string {
  return key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
}

function memberPath(path: string, key: string | symbol): string {
  if (typeof key === 'symbol') return `${path}[${String(key)}]`;
  return IDENTIFIER_NAME.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

// ---------------------------------------------------------------------------
// errors — `the export <path> is <problem>`, the problem ending with what to do
// ---------------------------------------------------------------------------

function unsupported(path: string, problem: string): Error {
  return new Error(`the export \`${path}\` is ${problem}`);
}

const A_FUNCTION =
  'a function, and a function cannot be precompiled. If it builds a script, turn its ' +
  'parameters into script arguments, or call it here with values known at build time.';

function notData(what: string): string {
  return (
    `${what}, which cannot be written into the bundle. A *.evs.ts module exports precompiled ` +
    `scripts and plain data (what JSON holds, plus bigint and undefined).`
  );
}

/**
 * The problem of an evs script that is not a precompiled script exported on its own. These are
 * objects, so they would otherwise be reported as a function somewhere inside them. A script and
 * a compiled script are told by the method that takes them one step further.
 */
function scriptProblem(value: object): string | undefined {
  if (isPrecompiledScript(value)) {
    return (
      'a precompiled script inside another value. Give each script an export of its own, so ' +
      'the bundler can drop the ones a page does not use.'
    );
  }
  if (hasMethod(value, 'toPrecompiled')) {
    return (
      'a compiled script, which holds the whole output of the compiler. Add `.toPrecompiled()` ' +
      'after `.compile()` to export the part a client runs.'
    );
  }
  if (hasMethod(value, 'compile')) {
    return 'a script that was not compiled. Export `evscript(...).compile().toPrecompiled()`.';
  }
  return undefined;
}

function hasMethod(value: object, name: string): boolean {
  const member: unknown = Reflect.get(value, name);
  return typeof member === 'function';
}

/** `an instance of Map`. */
function instanceOf(value: object): string {
  const constructor: unknown = Reflect.get(value, 'constructor');
  const name =
    typeof constructor === 'function' && constructor.name !== ''
      ? constructor.name
      : 'an anonymous class';
  return `an instance of ${name}`;
}
