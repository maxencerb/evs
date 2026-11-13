// @ts-check
// Sidebar tree and legacy-URL redirects for the docs site, imported by `astro.config.mjs`.
//
// Layout follows viem.sh: narrative groups first (Introduction, Guides, Examples, Concepts), then
// the API reference with one page per function. Reference groups are collapsed until the reader
// is inside one. Every slug here must exist under `src/content/docs/` or the build fails.

/** @typedef {NonNullable<import('@astrojs/starlight/types').StarlightUserConfig['sidebar']>} Sidebar */

/** @type {Sidebar} */
export const sidebar = [
  {
    label: 'Introduction',
    items: [
      { label: 'Why evs', slug: 'getting-started/why-evs' },
      { label: 'Installation', slug: 'getting-started/installation' },
      { label: 'Quick start', slug: 'getting-started/quick-start' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'Writing scripts', slug: 'guides/writing-scripts' },
      { label: 'Values & types', slug: 'guides/values-and-types' },
      { label: 'Calling contracts', slug: 'guides/calls' },
      { label: 'Control flow', slug: 'guides/control-flow' },
      { label: 'Executing scripts', slug: 'guides/execution' },
      { label: 'Errors & debugging', slug: 'guides/errors-and-debugging' },
      { label: 'Testing scripts', slug: 'guides/testing-scripts' },
      { label: 'EVM targets', slug: 'guides/evm-targets' },
    ],
  },
  {
    label: 'Examples',
    items: [
      { label: 'Uniswap V3 pool metadata', slug: 'examples/pool-metadata' },
      { label: 'Batch token balances', slug: 'examples/token-balances' },
      { label: 'More patterns', slug: 'examples/patterns' },
    ],
  },
  {
    label: 'Concepts',
    items: [
      { label: 'How it works', slug: 'concepts/how-it-works' },
      { label: 'Why trust the bytecode?', slug: 'concepts/trust-and-testing' },
    ],
  },
  {
    label: 'Script',
    items: [
      { label: 'evscript', slug: 'reference/evscript' },
      { label: 'compile', slug: 'reference/compile' },
    ],
  },
  {
    label: 'Builder',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'reference/builder' },
      {
        label: 'Values',
        items: [
          { label: 'lit', slug: 'reference/builder/lit' },
          { label: 'let', slug: 'reference/builder/let' },
          { label: 'newArray', slug: 'reference/builder/new-array' },
          { label: 'tuple', slug: 'reference/builder/tuple' },
          { label: 'env', slug: 'reference/builder/env' },
          { label: 'balance', slug: 'reference/builder/balance' },
        ],
      },
      {
        label: 'Calls',
        items: [
          { label: 'read', slug: 'reference/builder/read' },
          { label: 'tryRead', slug: 'reference/builder/try-read' },
          { label: 'call', slug: 'reference/builder/call' },
          { label: 'tryCall', slug: 'reference/builder/try-call' },
          { label: 'simulate', slug: 'reference/builder/simulate' },
          { label: 'trySimulate', slug: 'reference/builder/try-simulate' },
        ],
      },
      {
        label: 'Control flow',
        items: [
          { label: 'if', slug: 'reference/builder/if' },
          { label: 'select', slug: 'reference/builder/select' },
          { label: 'for', slug: 'reference/builder/for' },
          { label: 'forEach', slug: 'reference/builder/for-each' },
          { label: 'while', slug: 'reference/builder/while' },
          { label: 'fn', slug: 'reference/builder/fn' },
          { label: 'throw', slug: 'reference/builder/throw' },
          { label: 'return', slug: 'reference/builder/return' },
        ],
      },
      {
        label: 'Encoding',
        items: [
          { label: 'encode', slug: 'reference/builder/encode' },
          { label: 'encodePacked', slug: 'reference/builder/encode-packed' },
          { label: 'keccak256', slug: 'reference/builder/keccak256' },
        ],
      },
    ],
  },
  {
    label: 'Expr',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'reference/expr' },
      { label: 'Arithmetic', slug: 'reference/expr/arithmetic' },
      { label: 'Wrapping math', slug: 'reference/expr/wrapping' },
      { label: 'Full-precision math', slug: 'reference/expr/full-precision' },
      { label: 'Comparison', slug: 'reference/expr/comparison' },
      { label: 'Logic', slug: 'reference/expr/logic' },
      { label: 'Bitwise', slug: 'reference/expr/bitwise' },
      { label: 'Conversions', slug: 'reference/expr/conversions' },
      { label: 'Bytes & arrays', slug: 'reference/expr/bytes-and-arrays' },
    ],
  },
  {
    label: 'Types',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'reference/types' },
      { label: 'array', slug: 'reference/types/array' },
      { label: 'struct', slug: 'reference/types/struct' },
      { label: 'tuple', slug: 'reference/types/tuple' },
      { label: 'error', slug: 'reference/types/error' },
      { label: 'fromOutputs', slug: 'reference/types/from-outputs' },
      { label: 'namedArg', slug: 'reference/types/named-arg' },
    ],
  },
  {
    label: 'Artifact',
    collapsed: true,
    items: [
      { label: 'Overview', slug: 'reference/artifact' },
      { label: 'toViem', slug: 'reference/artifact/to-viem' },
      { label: 'disassemble', slug: 'reference/artifact/disassemble' },
      { label: 'explainRevert', slug: 'reference/artifact/explain-revert' },
    ],
  },
  {
    label: 'Utilities',
    collapsed: true,
    items: [
      { label: 'interpret', slug: 'reference/utilities/interpret' },
      { label: 'decodeScriptError', slug: 'reference/utilities/decode-script-error' },
      { label: 'matchScriptError', slug: 'reference/utilities/match-script-error' },
      { label: 'explainDeploylessError', slug: 'reference/utilities/explain-deployless-error' },
      { label: 'disassemble', slug: 'reference/utilities/disassemble' },
      { label: 'serializeIr', slug: 'reference/utilities/serialize-ir' },
      { label: 'dce', slug: 'reference/utilities/dce' },
      { label: 'evsPeephole', slug: 'reference/utilities/evs-peephole' },
    ],
  },
  {
    label: 'Errors',
    items: [{ label: 'Errors & diagnostics', slug: 'reference/diagnostics' }],
  },
];

/**
 * Pages that moved in the 2026-11 restructure (guides folded into per-function reference pages),
 * plus the removed in-browser playground.
 *
 * @type {Record<string, string>}
 */
export const redirects = {
  '/playground': '/',
  '/guides/arithmetic': '/reference/expr/arithmetic/',
  '/guides/hashing-encoding': '/reference/builder/keccak256/',
  '/guides/functions': '/reference/builder/fn/',
};
