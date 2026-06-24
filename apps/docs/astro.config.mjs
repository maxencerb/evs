// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import ecTwoSlash from 'expressive-code-twoslash';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightThemeRapide from 'starlight-theme-rapide';

// https://astro.build/config
export default defineConfig({
  site: 'https://evs.maxencerb.com',
  integrations: [
    starlight({
      title: 'evs',
      description:
        'Typed EVM read scripts in plain TypeScript — batch dozens of on-chain reads into a single eth_call, with full viem inference and no deployed contracts.',
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/maxencerb/evs' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@maxencerb/evs' },
      ],
      editLink: { baseUrl: 'https://github.com/maxencerb/evs/edit/main/apps/docs/' },
      // Twoslash renders real type-on-hover + inline errors for ```ts twoslash fences
      // (issue #13). The plain ```ts fences stay untouched (explicitTrigger) so the
      // bulk of the snippet-gate-checked examples are unaffected. We use the plugin's
      // default compiler options (it resolves @maxencerb/evs + viem from this package's
      // node_modules); every twoslash fence is ALSO checked by the stricter snippet gate
      // (scripts/check-snippets.ts), so a fence that twoslashes is a valid standalone
      // module and vice versa.
      expressiveCode: {
        // explicitTrigger (default true) keeps Twoslash to ```ts twoslash fences only, so the
        // ~100 plain ```ts snippets are untouched by it (the snippet gate still checks them all).
        plugins: [ecTwoSlash({ instanceConfigs: { twoslash: { explicitTrigger: true } } })],
      },
      plugins: [
        starlightThemeRapide(),
        // /llms.txt + /llms-full.txt for LLM ingestion (issue #14); code fences kept intact.
        starlightLlmsTxt({
          projectName: 'evs',
          description:
            'Typed EVM read scripts in plain TypeScript: a callback-builder compiled to EVM bytecode that batches dozens of dependent on-chain reads into a single deployless eth_call, with full viem type inference and no deployed contracts.',
          details:
            'evs (`@maxencerb/evs`) lets you write read-only EVM scripts in TypeScript, compile them to runtime bytecode, and execute them with viem in one eth_call — including reads whose targets depend on earlier reads, which multicall cannot batch.',
          optionalLinks: [
            { label: 'GitHub repository', url: 'https://github.com/maxencerb/evs' },
            { label: 'npm package', url: 'https://www.npmjs.com/package/@maxencerb/evs' },
          ],
        }),
        starlightLinksValidator(),
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Why evs?', slug: 'getting-started/why-evs' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick start', slug: 'getting-started/quick-start' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Writing scripts', slug: 'guides/writing-scripts' },
            { label: 'Values & types', slug: 'guides/values-and-types' },
            { label: 'Arithmetic & checked math', slug: 'guides/arithmetic' },
            { label: 'Calling contracts', slug: 'guides/calls' },
            { label: 'Control flow & cells', slug: 'guides/control-flow' },
            { label: 'User functions', slug: 'guides/functions' },
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
          label: 'Reference',
          items: [
            { label: 'evscript() & compile()', slug: 'reference/evscript' },
            { label: 'ScriptBuilder', slug: 'reference/builder' },
            { label: 'The t type namespace', slug: 'reference/types' },
            { label: 'The compiled artifact', slug: 'reference/artifact' },
            { label: 'Errors & diagnostics', slug: 'reference/diagnostics' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'How it works', slug: 'concepts/how-it-works' },
            { label: 'Why trust the bytecode?', slug: 'concepts/trust-and-testing' },
          ],
        },
      ],
    }),
  ],
});
