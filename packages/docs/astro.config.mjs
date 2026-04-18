import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsSite = process.env.DOCS_SITE_URL ?? 'https://last-shot-labs.github.io/slingshot/';

export default defineConfig({
  site: docsSite,
  vite: {
    resolve: {
      alias: {
        // Force Astro/Starlight to use Zod v3 from this package,
        // not the hoisted Zod v4 from the workspace root.
        zod: resolve(__dirname, 'node_modules/zod'),
      },
    },
  },
  integrations: [
    starlight({
      title: 'Slingshot',
      disable404Route: true,
      description:
        'Composable Slingshot packages for app assembly, auth, config-driven entities, realtime, and platform tooling',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/lastshotlabs/slingshot',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/lastshotlabs/slingshot/edit/main/packages/docs/',
      },
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Start Here', slug: 'start-here' },
            { label: 'Introduction', slug: 'getting-started' },
            { label: 'Quick Start', slug: 'quick-start' },
            { label: 'Installation', slug: 'installation' },
            { label: 'Manifest vs Code', slug: 'manifest-vs-code' },
            { label: 'FAQ', slug: 'faq' },
          ],
        },
        {
          label: 'Agent Flows',
          items: [
            { label: 'Framework Contributor', slug: 'agent-flows/framework-contributor' },
            { label: 'App Builder', slug: 'agent-flows/app-builder' },
          ],
        },
        {
          label: 'Config-Driven',
          items: [
            { label: 'Overview', slug: 'config-driven' },
            { label: 'Workflow', slug: 'config-driven/workflow' },
            { label: 'Operations Reference', slug: 'config-driven/operations' },
            { label: 'Infrastructure', slug: 'config-driven/infra' },
          ],
        },
        {
          label: 'Examples',
          items: [
            { label: 'Overview', slug: 'examples' },
            { label: 'Auth Setup', slug: 'examples/with-auth' },
            { label: 'Forum App', slug: 'examples/forum-app' },
            { label: 'SaaS Foundations', slug: 'examples/saas-foundations' },
            { label: 'Collaboration Workspace', slug: 'examples/collaboration-workspace' },
            { label: 'Content Platform', slug: 'examples/content-platform' },
            { label: 'Config-Driven Domain', slug: 'examples/config-driven-domain' },
            { label: 'Custom Plugin', slug: 'examples/custom-plugin' },
            { label: 'Adding Search', slug: 'examples/adding-search' },
            { label: 'Production Databases', slug: 'examples/production-databases' },
            { label: 'Realtime with SSE', slug: 'examples/realtime-sse' },
            { label: 'Custom Event Bus', slug: 'examples/custom-event-bus' },
            { label: 'Game Engine', slug: 'examples/game-engine' },
          ],
        },
        {
          label: 'Guides',
          items: [
            {
              label: 'Core',
              items: [
                { label: 'OpenAPI', slug: 'guides/openapi' },
                { label: 'Error Handling', slug: 'guides/error-handling' },
                { label: 'File Uploads', slug: 'guides/file-uploads' },
                { label: 'Realtime', slug: 'realtime' },
                { label: 'WebSockets', slug: 'guides/websockets' },
                { label: 'Multi-Tenancy', slug: 'guides/multi-tenancy' },
              ],
            },
            {
              label: 'Production',
              items: [
                { label: 'Security', slug: 'guides/security' },
                { label: 'Secrets', slug: 'guides/secrets' },
                { label: 'Testing', slug: 'guides/testing' },
                { label: 'Monitoring', slug: 'guides/monitoring' },
                { label: 'Deployment', slug: 'guides/deployment' },
                { label: 'Horizontal Scaling', slug: 'guides/horizontal-scaling' },
                { label: 'Runtime', slug: 'guides/runtime' },
              ],
            },
            {
              label: 'Troubleshooting',
              items: [{ label: 'Common Problems', slug: 'guides/troubleshooting' }],
            },
          ],
        },
        {
          label: 'Packages',
          collapsed: true,
          autogenerate: { directory: 'packages' },
        },
        {
          label: 'Build a Plugin',
          collapsed: true,
          items: [
            { label: 'How It Works', slug: 'plugins/overview' },
            { label: 'Workflow', slug: 'config-driven/workflow' },
            { label: 'Config-Driven Walkthrough', slug: 'config-driven-walkthrough' },
            { label: 'Operations Reference', slug: 'config-driven/operations' },
            { label: 'Step-by-Step Example', slug: 'examples/config-driven-domain' },
            { label: 'Plugin Interface', slug: 'authoring/plugin-interface' },
            { label: 'SlingshotContext', slug: 'authoring/context' },
            { label: 'CoreRegistrar', slug: 'authoring/registrar' },
            { label: 'Event Bus', slug: 'authoring/event-bus' },
            { label: 'Testing Plugins', slug: 'authoring/testing-plugins' },
            { label: 'Publishing', slug: 'authoring/publishing' },
          ],
        },
        {
          label: 'Internals',
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'internals' },
            { label: 'Plugin Lifecycle', slug: 'internals/plugin-lifecycle' },
            { label: 'Context and Registrar', slug: 'internals/context-registrar' },
            { label: 'The Event Bus', slug: 'internals/event-bus' },
            { label: 'Reflect Symbol DI', slug: 'internals/reflect-di' },
            { label: 'Persistence Resolution', slug: 'internals/persistence' },
            { label: 'The Manifest System', slug: 'internals/manifest' },
            { label: 'Secrets', slug: 'internals/secrets' },
          ],
        },
        {
          label: 'API Reference',
          collapsed: true,
          autogenerate: { directory: 'api' },
        },
      ],
    }),
  ],
});
