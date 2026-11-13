// @ts-check
import starlight from '@astrojs/starlight';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

import { redirects, sidebar } from './sidebar.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://evs.maxencerb.com',
  // Legacy URLs (moved pages, the removed playground): see sidebar.mjs.
  redirects,
  vite: {
    build: {
      rollupOptions: {
        // Astro tags every content module with a "use astro:head-inject" directive that it
        // reads itself. Rolldown then warns, once per page, that a bundle may not preserve a
        // module-level directive: dozens of identical notices that bury any real warning.
        onwarn(warning, defaultHandler) {
          const expected =
            warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
            warning.message.includes('astro:head-inject');
          if (!expected) defaultHandler(warning);
        },
      },
    },
  },
  integrations: [
    starlight({
      title: 'evs',
      description:
        'Typed EVM read scripts in plain TypeScript. Batch dozens of dependent on-chain reads into a single eth_call, with full viem inference and no deployed contracts.',
      favicon: '/favicon.svg',
      // The 404 page is src/pages/404.astro.
      disable404Route: true,
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/maxencerb/evs' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@maxencerb/evs' },
      ],
      editLink: { baseUrl: 'https://github.com/maxencerb/evs/edit/main/apps/docs/' },
      // Order matters: the fonts and tokens must exist before theme.css maps them onto
      // Starlight's `--sl-*` variables. All of it is unlayered, so it wins over Starlight's own
      // `@layer starlight.*` rules whatever their specificity.
      customCss: [
        '@fontsource-variable/geist',
        './src/styles/tokens.css',
        './src/styles/theme.css',
      ],
      components: {
        // Landing-page hero with the animated banner ridges; only `index.mdx` uses
        // `template: splash` + `hero`, so no other page is affected.
        Hero: './src/components/Hero.astro',
        // Top bar: wordmark, search, section links, GitHub / npm, package version.
        Header: './src/components/Header.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        // Sidebar tree plus a pinned footer (social icons, theme switch) on every viewport.
        Sidebar: './src/components/Sidebar.astro',
        // Three-state segmented switch (light / dark / system) instead of a <select>.
        ThemeSelect: './src/components/ThemeSelect.astro',
        // Title plus the "Copy page" / "View as Markdown" actions where no right column shows.
        PageTitle: './src/components/PageTitle.astro',
        // "On this page" plus the same page actions in the right column.
        PageSidebar: './src/components/PageSidebar.astro',
      },
      // Adds `<link rel="alternate" type="text/markdown">` to every page's head.
      routeMiddleware: './src/route-data.ts',
      // `collapse={a-b}` fence meta folds boilerplate (long ABIs) behind a "N collapsed lines"
      // toggle; the snippet gate (scripts/check-snippets.ts) still typechecks the whole fence.
      // (Twoslash type-on-hover was dropped on 2026-09-14: ~30s of the Cloudflare build for six
      // fences — inferred types are written out as comments instead.)
      expressiveCode: {
        plugins: [pluginCollapsibleSections()],
        themes: ['github-dark-dimmed', 'github-light'],
        // Shell fences would otherwise get a terminal frame (window dots and a title bar).
        defaultProps: { frame: 'code' },
        styleOverrides: {
          borderRadius: 'var(--evs-radius)',
          borderWidth: '1px',
          borderColor: 'var(--evs-border)',
          codeBackground: 'var(--evs-code-bg)',
          codeFontFamily: 'var(--evs-font-mono)',
          // 13px in the system monospace: an 88-column line, the width the pages' examples are
          // wrapped to, then fits the article column without scrolling.
          codeFontSize: '0.8125rem',
          codeLineHeight: '1.25rem',
          codePaddingBlock: '1.25rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--evs-font-sans)',
          uiFontSize: '0.8125rem',
          focusBorder: 'var(--evs-accent)',
          scrollbarThumbColor: 'var(--evs-border-strong)',
          scrollbarThumbHoverColor: 'var(--evs-text-3)',
          frames: {
            frameBoxShadowCssValue: 'none',
            editorBackground: 'var(--evs-code-bg)',
            terminalBackground: 'var(--evs-code-bg)',
            // A `title="file.ts"` renders as one flat file tab on the tab-bar surface.
            editorTabBarBackground: 'var(--evs-surface)',
            editorTabBarBorderColor: 'var(--evs-border)',
            editorTabBarBorderBottomColor: 'var(--evs-border)',
            editorActiveTabBackground: 'transparent',
            editorActiveTabForeground: 'var(--evs-heading)',
            editorActiveTabBorderColor: 'transparent',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBorderRadius: '0',
            editorTabsMarginInlineStart: '0',
            editorTabsMarginBlockStart: '0',
            terminalTitlebarBackground: 'var(--evs-surface)',
            terminalTitlebarForeground: 'var(--evs-heading)',
            terminalTitlebarBorderBottomColor: 'var(--evs-border)',
            terminalTitlebarDotsOpacity: '0',
            inlineButtonBackground: 'var(--evs-text-2)',
            inlineButtonForeground: 'var(--evs-text-2)',
            inlineButtonBorder: 'var(--evs-border-strong)',
            inlineButtonBorderOpacity: '1',
            inlineButtonBackgroundIdleOpacity: '0',
            inlineButtonBackgroundHoverOrFocusOpacity: '0.12',
            inlineButtonBackgroundActiveOpacity: '0.2',
            tooltipSuccessBackground: 'var(--evs-heading)',
            tooltipSuccessForeground: 'var(--evs-surface)',
          },
          // `{5}` marks a focus line: theme.css dims the rest of the block instead of painting
          // the marked line, so the marker itself is invisible.
          textMarkers: {
            markBackground: 'transparent',
            markBorderColor: 'transparent',
            lineMarkerAccentWidth: '0',
          },
          collapsibleSections: {
            closedBackgroundColor: 'var(--evs-surface)',
            closedBorderColor: 'var(--evs-border)',
            closedBorderWidth: '1px',
            closedTextColor: 'var(--evs-text-2)',
            closedFontFamily: 'var(--evs-font-sans)',
            closedFontSize: '0.8125rem',
            closedLineHeight: '1.25rem',
            closedPaddingBlock: '0.375rem',
            closedMargin: '0.375rem 0',
            openBackgroundColorCollapsible: 'transparent',
            openBorderColor: 'transparent',
          },
        },
      },
      plugins: [starlightLinksValidator()],
      sidebar,
    }),
  ],
});
