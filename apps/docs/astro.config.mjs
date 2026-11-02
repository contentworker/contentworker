// contentworker docs: Starlight over MDX in src/content/. Static output, deployed as a Workers
// static-assets site (wrangler.jsonc). Reference pages render from @contentworker/domain and the
// API's OpenAPI document at build time, so the node catalog, workflow templates, permission
// scopes and endpoint list can't drift from the code.
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://docs.contentworker.app',
  // No image transforms: the default service needs `sharp`, a native dependency these docs
  // don't otherwise need.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'contentworker',
      // The mark in brand beside the wordmark, as in the admin's header (the dark theme's lighter brand).
      logo: { light: './src/assets/mark-light.svg', dark: './src/assets/mark-dark.svg' },
      description:
        'contentworker is an API-first, AI-agentic headless CMS. Guides for the people who write and approve content, and reference for the developers who integrate with it.',
      // Prose lives at src/content/ (see content.config.ts). Without this Starlight skips its
      // Markdown transforms (asides, heading anchors) for files outside src/content/docs/.
      markdown: { processedDirs: ['./src/content'] },
      // Code blocks on the admin's panel ground with its hairline and corners. GitHub's themes
      // keep syntax colour quiet next to the achromatic slate.
      expressiveCode: {
        themes: ['github-dark-dimmed', 'github-light'],
        defaultProps: { frame: 'code' },
        styleOverrides: {
          borderColor: 'var(--cw-border)',
          borderRadius: 'calc(var(--cw-radius) * 0.8)',
          codeBackground: 'var(--cw-card)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: '0.8125rem',
          uiFontFamily: 'var(--sl-font)',
          frames: {
            editorBackground: 'var(--cw-card)',
            editorActiveTabBackground: 'var(--cw-card)',
            editorTabBarBackground: 'var(--cw-muted)',
            editorTabBarBorderBottomColor: 'var(--cw-border)',
            terminalBackground: 'var(--cw-card)',
            terminalTitlebarBackground: 'var(--cw-muted)',
            terminalTitlebarBorderBottomColor: 'var(--cw-border)',
            frameBoxShadowCssValue: 'none',
            inlineButtonBorder: 'var(--cw-border)',
          },
        },
      },
      components: {
        // The admin's theme rule (Ledger): match the system unless Light or Dark is chosen.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        // A page header: the title, the page's description muted under it.
        PageTitle: './src/components/PageTitle.astro',
        // The top bar's one action: the API explorer as a pill.
        SocialIcons: './src/components/SocialIcons.astro',
      },
      // The admin's one face, self-hosted (the docs fetch no font from a third party), then the
      // theme: theme.css is generated from the admin's tokens (`sync:theme`); brand.css is
      // hand-written.
      customCss: [
        '@fontsource-variable/inter/wght.css',
        './src/styles/theme.css',
        './src/styles/brand.css',
      ],
      head: [{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' } }],
      // Explicit sidebar: autogenerate expects src/content/docs/. A new page is invisible until it
      // is listed here. Start reads as a sequence (Starlight's prev/next follows this order).
      // The site is for people who use a workspace and developers who integrate with one;
      // deployment, configuration and internals stay in the repo's docs/ folder, unpublished.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'start/getting-started' },
            { label: 'Concepts', slug: 'start/concepts' },
          ],
        },
        {
          label: 'Working with content',
          items: [
            { label: 'Content modeling', slug: 'guides/content-modeling' },
            { label: 'Editing and publishing', slug: 'guides/editing-and-publishing' },
            { label: 'Media and assets', slug: 'guides/media' },
            { label: 'Share assets with a link', slug: 'guides/share-links' },
            { label: 'Releases and scheduling', slug: 'guides/releases-and-scheduling' },
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'Workflows', slug: 'guides/workflows' },
            { label: 'Approvals and reviews', slug: 'guides/approvals' },
            { label: 'AI features', slug: 'guides/ai' },
            { label: 'Coworker', slug: 'guides/coworker' },
          ],
        },
        {
          label: 'Integrating',
          items: [
            { label: 'API keys and access', slug: 'guides/api-keys' },
            { label: 'Team and roles', slug: 'guides/team-and-roles' },
            { label: 'Reading content', slug: 'guides/reading-content' },
            { label: 'Delivering assets', slug: 'guides/delivering-assets' },
            { label: 'Webhooks', slug: 'guides/webhooks' },
            { label: 'SDKs', slug: 'guides/sdks' },
            { label: 'MCP server', slug: 'guides/mcp' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'REST API', slug: 'reference/rest-api' },
            { label: 'Node catalog', slug: 'reference/nodes' },
            { label: 'Workflow templates', slug: 'reference/workflow-templates' },
            { label: 'Permission scopes', slug: 'reference/scopes' },
            // Scalar over the OpenAPI document generated from the API (src/pages/api.astro).
            { label: 'OpenAPI explorer', link: '/api/' },
          ],
        },
      ],
    }),
  ],
});
