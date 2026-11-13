/**
 * The import graph of the compiler-free entry (`runtime.ts`).
 *
 * `@maxencerb/evs/runtime` exists so a client that holds only precompiled scripts never
 * downloads the compiler. Nothing else enforces that: one value import of a compiler module, in
 * any module the entry reaches, puts the compiler in every client bundle and no other test
 * fails. So this file walks the source import graph and, for each compiler module it reaches,
 * reports the chain of imports that leads there.
 *
 * What counts as an edge is what a bundler follows: `import` / `export … from` statements that
 * are not type-only (under `verbatimModuleSyntax` those stay in the output even when every named
 * binding is a type). A dynamic `import()` is not an edge: it starts a chunk of its own, whose
 * graph is checked separately.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, test } from 'vite-plus/test';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The compiler: recording, validation, lowering, assembly, and the interpreter. */
const COMPILER: readonly RegExp[] = [
  /^compile\.ts$/,
  /^builder\//,
  /^codegen\//,
  /^asm\/(assembler|verify|disasm)\.ts$/,
  /^ir\/(validate|dce)\.ts$/,
  /^ir\/interp/,
];

/** The frozen opcode table: no bundler drops it from a module it keeps (`asm/forks.ts`). */
const OPCODE_TABLE = /^asm\/ops\.ts$/;

interface Imports {
  /** Value imports and re-exports: what a bundler puts in the importer's chunk. */
  readonly static: readonly string[];
  /** `import()` targets: each one starts a chunk loaded on demand. */
  readonly dynamic: readonly string[];
}

/** The relative imports of the module `file` (a path under `src/`), as paths under `src/`. */
function importsOf(file: string): Imports {
  const path = join(SRC, file);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
  const found = { static: new Set<string>(), dynamic: new Set<string>() };
  const add = (kind: keyof typeof found, specifier: string): void => {
    if (!specifier.startsWith('.')) return; // a package (viem): not part of the source graph
    const target = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
    if (!existsSync(target)) throw new Error(`${file} imports ${specifier}, which does not exist`);
    found[kind].add(relative(SRC, target));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly === true
        : node.isTypeOnly;
      const specifier = node.moduleSpecifier;
      if (!typeOnly && specifier !== undefined && ts.isStringLiteral(specifier)) {
        add('static', specifier.text);
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        add('dynamic', specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { static: [...found.static], dynamic: [...found.dynamic] };
}

interface Closure {
  /** Every module reached through static imports, with the module that first imported it. */
  readonly importerOf: ReadonlyMap<string, string | undefined>;
  /** The `import()` targets met on the way. */
  readonly lazy: ReadonlySet<string>;
}

/** Breadth-first, so `importerOf` traces a shortest chain back to `entry`. */
function closureOf(entry: string): Closure {
  const importerOf = new Map<string, string | undefined>([[entry, undefined]]);
  const lazy = new Set<string>();
  const queue = [entry];
  for (const file of queue) {
    const imports = importsOf(file);
    for (const target of imports.dynamic) lazy.add(target);
    for (const target of imports.static) {
      if (importerOf.has(target)) continue;
      importerOf.set(target, file);
      queue.push(target);
    }
  }
  return { importerOf, lazy };
}

/** `entry → … → file`, the imports that lead from the closure's entry to `file`. */
function chainTo(closure: Closure, file: string): string {
  const chain = [file];
  for (let at = closure.importerOf.get(file); at !== undefined; at = closure.importerOf.get(at)) {
    chain.unshift(at);
  }
  return chain.join(' → ');
}

/** The import chains from `entry` to each module one of `forbidden` matches. */
function chainsInto(entry: string, forbidden: readonly RegExp[]): string[] {
  const closure = closureOf(entry);
  return [...closure.importerOf.keys()]
    .filter((file) => forbidden.some((pattern) => pattern.test(file)))
    .map((file) => chainTo(closure, file));
}

/** Every module loaded on demand from `entry`: its `import()` targets, and theirs. */
function lazyRootsOf(entry: string): string[] {
  const roots = new Set<string>();
  const queue = [entry];
  for (const file of queue) {
    for (const target of closureOf(file).lazy) {
      if (roots.has(target)) continue;
      roots.add(target);
      queue.push(target);
    }
  }
  return [...roots];
}

describe('the walker', () => {
  test('sees the compiler from the main entry, with the chain that reaches it', () => {
    const chains = chainsInto('index.ts', COMPILER);
    expect(chains).toContain('index.ts → compile.ts');
    expect(chains).toContain('index.ts → compile.ts → asm/assembler.ts');
    expect(chains.some((chain) => chain.endsWith('codegen/program.ts'))).toBe(true);
  });

  test('follows value imports only: a type-only import is not an edge', () => {
    // compile.ts names EvsScript through `import type` and builds on the pipeline by value
    const { static: imports } = importsOf('compile.ts');
    expect(imports).toContain('codegen/program.ts');
    expect(imports).not.toContain('builder/script.ts');
  });
});

describe('@maxencerb/evs/runtime is compiler-free', () => {
  test('runtime.ts reaches no compiler module through static imports', () => {
    expect(
      chainsInto('runtime.ts', COMPILER),
      'import chains from runtime.ts into the compiler: every client bundle would carry it',
    ).toEqual([]);
  });

  test('nor the opcode table', () => {
    expect(
      chainsInto('runtime.ts', [OPCODE_TABLE]),
      'import chains from runtime.ts to asm/ops.ts: take the fork facts from asm/forks.ts',
    ).toEqual([]);
  });

  test('the explain code is loaded on demand, never statically', () => {
    expect(lazyRootsOf('runtime.ts')).toEqual(['explain.ts']);
    expect(
      chainsInto('runtime.ts', [/^explain\.ts$/]),
      'static import chains from runtime.ts to explain.ts: it must stay a dynamic import',
    ).toEqual([]);
  });

  test.each(lazyRootsOf('runtime.ts'))(
    'what loads on demand reaches no compiler module either: %s',
    (root) => {
      expect(
        chainsInto(root, COMPILER),
        `import chains from ${root} into the compiler: the on-demand chunk would carry it`,
      ).toEqual([]);
      expect(lazyRootsOf(root)).toEqual([]);
    },
  );
});
