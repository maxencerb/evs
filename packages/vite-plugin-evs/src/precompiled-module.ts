/**
 * `precompiled-module.ts` — the code that replaces a build-time module: its exports, written
 * out as values.
 *
 * A precompiled script becomes a `hydrate(...)` call on its data, plain data becomes a literal,
 * and any other export is an error that says what to change. The plugin does not know what a
 * precompiled script is made of: it asks `@maxencerb/evs/runtime` whether a value is one,
 * serializes it with `JSON.stringify`, and leaves the rest to `hydrate`.
 */

import { isPrecompiledScript } from '@maxencerb/evs/runtime';

import { debugModuleCode, debugModuleId, debugModuleSpecifier } from './debug-module.js';

export interface PrecompiledModule {
  /** The module's new source. */
  readonly code: string;
  /** How many of its exports are precompiled scripts. */
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
  const rendered = await Promise.all(
    Object.entries(exports).map(async ([name, value]) => renderExport(file, name, value)),
  );
  const debugModules = rendered.flatMap(({ debugModule }) =>
    debugModule === undefined ? [] : [debugModule],
  );

  // a local binding per export, so every export name works: `default`, a reserved word
  const bindings = rendered.map(({ expression }, index) => `const _${index} = ${expression};`);
  const names = rendered.map(({ name }, index) => `_${index} as ${exportName(name)}`);
  const lines = [
    ...(debugModules.length > 0 ? [`import { hydrate } from '@maxencerb/evs/runtime';`] : []),
    ...bindings,
    names.length > 0 ? `export { ${names.join(', ')} };` : 'export {};',
  ];
  return {
    code: `${lines.join('\n')}\n`,
    scripts: debugModules.length,
    debugModules: new Map(debugModules),
  };
}

interface RenderedExport {
  readonly name: string;
  /** The expression that evaluates to the export's value. */
  readonly expression: string;
  /** For a precompiled script, the module its debug data is served from: `[id, source]`. */
  readonly debugModule?: readonly [id: string, code: string];
}

async function renderExport(file: string, name: string, value: unknown): Promise<RenderedExport> {
  if (!isPrecompiledScript(value)) return { name, expression: toLiteral(value, name, []) };

  const debugJson = JSON.stringify(await value.debug());
  const specifier = debugModuleSpecifier(file, debugJson);
  return {
    name,
    // PURE: a script the app never uses is dropped from the bundle, like any unused export
    expression:
      `/* @__PURE__ */ hydrate(${JSON.stringify(value)}, ` +
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

  if (Array.isArray(value)) {
    const items = Array.from(value, (item: unknown, index) =>
      toLiteral(item, `${path}[${index}]`, inside),
    );
    return `[${items.join(', ')}]`;
  }

  const script = scriptProblem(value);
  if (script !== undefined) throw unsupported(path, script);
  if (!isPlainObject(value)) throw unsupported(path, notData(`an instance of ${classOf(value)}`));

  const properties = Object.entries(value).map(
    ([key, item]) => `${propertyKey(key)}: ${toLiteral(item, memberPath(path, key), inside)}`,
  );
  return `{ ${properties.join(', ')} }`;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A property key of an object literal. `__proto__` is computed: written plainly, it would set
 *  the prototype instead of a property. */
function propertyKey(key: string): string {
  return key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
}

function memberPath(path: string, key: string): string {
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

/** The problem of an evs script that is not a precompiled script exported on its own: these
 *  are objects, so they would otherwise be reported as a function somewhere inside them. */
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

function classOf(value: object): string {
  const constructor: unknown = Reflect.get(value, 'constructor');
  return typeof constructor === 'function' && constructor.name !== ''
    ? constructor.name
    : 'an anonymous class';
}
