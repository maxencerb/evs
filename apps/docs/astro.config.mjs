// @ts-check
import starlight from '@astrojs/starlight';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import { defineConfig } from 'astro/config';
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
        'Typed EVM read scripts in plain TypeScript. Batch dozens of dependent on-chain reads into a single eth_call, with full viem inference and no deployed contracts.',
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/maxencerb/evs' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@maxencerb/evs' },
      ],
      editLink: { baseUrl: 'https://github.com/maxencerb/evs/edit/main/apps/docs/' },
      // Landing-page hero with the animated banner ridges (src/components/Hero.astro); only
      // `index.mdx` uses `template: splash` + `hero`, so no other page is affected.
      components: { Hero: './src/components/Hero.astro' },
      // `collapse={a-b}` fence meta folds boilerplate (long ABIs) behind a "N collapsed lines"
      // toggle; the snippet gate (scripts/check-snippets.ts) still typechecks the whole fence.
      // (Twoslash type-on-hover was dropped on 2026-09-14: ~30s of the Cloudflare build for six
      // fences — inferred types are written out as comments instead.)
      expressiveCode: { plugins: [pluginCollapsibleSections()] },
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
        // /playground is a custom (non-Starlight) page the validator can't see.
        starlightLinksValidator({ exclude: ['/playground/'] }),
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Why evs?', slug: 'getting-started/why-evs' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick start', slug: 'getting-started/quick-start' },
            { label: 'Playground', link: '/playground' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Writing scripts', slug: 'guides/writing-scripts' },
            { label: 'Values & types', slug: 'guides/values-and-types' },
            { label: 'Arithmetic & checked math', slug: 'guides/arithmetic' },
            { label: 'Hashing & ABI encoding', slug: 'guides/hashing-encoding' },
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
