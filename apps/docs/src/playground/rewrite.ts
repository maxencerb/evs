/**
 * Import rewriting for the playground run path.
 *
 * The user module executes as a blob: URL. Static imports inside a blob module
 * proved fragile in production (the browser reports only the parent blob URL
 * when any child fetch fails, and blob-initiated subresource loads can be
 * blocked by privacy shields), so the rewritten module has NO imports at all:
 * the harness pre-imports the runtime bundles and exposes them on a global
 * registry, and user import statements become destructuring from it.
 *
 * No monaco dependency — `scripts/check-playground-examples.ts` runs this exact
 * code headlessly against the built bundles.
 */

export const MODULE_URLS: Record<string, string> = {
  '@maxencerb/evs': '/playground/evs.js',
  viem: '/playground/viem.js',
};

export const REGISTRY_KEY = '__EVS_PLAYGROUND_MODULES__';

// No backreference for the closing quote — SPEC composes into larger regexes
// where group numbering shifts (tsc emit never mixes quote styles anyway).
const SPEC = String.raw`['"](@maxencerb\/evs|viem)['"]`;
const registryRef = (spec: string) => `globalThis.${REGISTRY_KEY}[${JSON.stringify(spec)}]`;

/** `a as b, c` (import syntax) → `a: b, c` (destructuring syntax). */
const toDestructuring = (names: string) =>
  names.replace(/(\s)as(\s)/g, '$1:$2').replace(/\sas\s/g, ': ');

export function rewriteImports(js: string): string {
  let out = js;

  // Unsupported: re-exports of the runtime modules.
  if (new RegExp(String.raw`export\s[^;]*?from\s*${SPEC}`).test(out)) {
    throw new Error(
      `Re-exporting from '@maxencerb/evs' or 'viem' is not supported in the playground — import and use them instead.`,
    );
  }

  // import * as ns from 'spec'
  out = out.replace(
    new RegExp(String.raw`import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*${SPEC}`, 'g'),
    (_full, name: string, spec: string) => `const ${name} = ${registryRef(spec)}`,
  );
  // import def, { a, b as c } from 'spec'
  out = out.replace(
    new RegExp(String.raw`import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*${SPEC}`, 'g'),
    (_full, def: string, names: string, spec: string) =>
      `const ${def} = ${registryRef(spec)}.default, {${toDestructuring(names)}} = ${registryRef(spec)}`,
  );
  // import { a, b as c } from 'spec'
  out = out.replace(
    new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${SPEC}`, 'g'),
    (_full, names: string, spec: string) =>
      `const {${toDestructuring(names)}} = ${registryRef(spec)}`,
  );
  // import def from 'spec'
  out = out.replace(
    new RegExp(String.raw`import\s+([A-Za-z_$][\w$]*)\s+from\s*${SPEC}`, 'g'),
    (_full, def: string, spec: string) => `const ${def} = ${registryRef(spec)}.default`,
  );
  // side-effect import 'spec'
  out = out.replace(
    new RegExp(String.raw`import\s*${SPEC}\s*;?`, 'g'),
    (_full, spec: string) => `void ${registryRef(spec)};`,
  );
  // dynamic import('spec') → the registry, wrapped in a promise like the real thing
  out = out.replace(
    new RegExp(String.raw`\bimport\s*\(\s*${SPEC}\s*\)`, 'g'),
    (_full, spec: string) => `Promise.resolve(${registryRef(spec)})`,
  );

  // Anything still importing a bare specifier is unavailable here.
  const leftover = out.match(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/);
  if (leftover && !/^(\.|\/|https?:|blob:|data:)/.test(leftover[2] ?? '')) {
    throw new Error(
      `Cannot import '${leftover[2]}' — only '@maxencerb/evs' and 'viem' are available in the playground.`,
    );
  }

  return out;
}
