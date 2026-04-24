import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsSite = process.env.DOCS_SITE_URL ?? 'https://lastshotlabs.github.io';
const spawnBlocked = process.env.SLINGSHOT_DOCS_SPAWN_BLOCKED === '1';

export default defineConfig({
  site: docsSite,
  base: '/slingshot',
  vite: {
    ...(spawnBlocked
      ? {
          optimizeDeps: {
            noDiscovery: true,
            include: [],
          },
          ssr: {
            optimizeDeps: {
              noDiscovery: true,
              include: [],
            },
          },
          environments: {
            client: {
              optimizeDeps: {
                noDiscovery: true,
                include: [],
              },
            },
            ssr: {
              optimizeDeps: {
                noDiscovery: true,
                include: [],
              },
            },
          },
        }
      : {}),
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
        'Composable Slingshot packages for app assembly, package-first authoring, entities, events, realtime, and platform tooling',
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
            { label: 'FAQ', slug: 'faq' },
          ],
        },
        {
          label: 'App Authoring',
          items: [
            { label: 'Overview', slug: 'app-authoring' },
            {
              label: 'createServer and createApp',
              slug: 'app-authoring/create-server-and-create-app',
            },
            { label: 'Starter App', slug: 'app-authoring/starter-app' },
            { label: 'App Config', slug: 'app-authoring/app-config' },
            {
              label: 'Context and Request Model',
              slug: 'app-authoring/context-and-request-model',
            },
            { label: 'Middleware', slug: 'app-authoring/middleware' },
            { label: 'Packages and Plugins', slug: 'app-authoring/packages-and-plugins' },
            {
              label: 'OpenAPI and Validation',
              slug: 'app-authoring/openapi-and-validation',
            },
            {
              label: 'Runtime and Infrastructure',
              slug: 'app-authoring/runtime-and-infrastructure',
            },
          ],
        },
        {
          label: 'Core Features',
          items: [
            {
              label: 'Events and the Event Bus',
              slug: 'app-authoring/events-and-the-event-bus',
            },
            { label: 'WebSockets', slug: 'app-authoring/websockets' },
            { label: 'Server-Sent Events', slug: 'app-authoring/server-sent-events' },
            {
              label: 'Auth',
              slug: 'examples/with-auth',
              badge: { text: 'Preview', variant: 'caution' },
            },
            {
              label: 'Permissions',
              slug: 'guides/permissions',
              badge: { text: 'Preview', variant: 'caution' },
            },
            {
              label: 'Multi-Tenancy',
              slug: 'guides/multi-tenancy',
              badge: { text: 'Preview', variant: 'caution' },
            },
            {
              label: 'Jobs and Orchestration',
              slug: 'orchestration/overview',
              badge: { text: 'Preview', variant: 'caution' },
            },
          ],
        },
        {
          label: 'Package-First Authoring',
          items: [
            { label: 'Overview', slug: 'package-first' },
            { label: 'definePackage', slug: 'package-first/define-package' },
            { label: 'domain and route', slug: 'package-first/domain-and-route' },
            {
              label: 'Capabilities and entityRef',
              slug: 'package-first/capabilities-and-entity-ref',
            },
            { label: 'Escape Hatches', slug: 'package-first/escape-hatches' },
          ],
        },
        {
          label: 'Entity System',
          items: [
            { label: 'Overview', slug: 'entity-system' },
            { label: 'defineEntity', slug: 'entity-system/define-entity' },
            { label: 'Route Policy', slug: 'entity-system/route-policy' },
            { label: 'Operations', slug: 'entity-system/operations' },
            {
              label: 'Storage and Adapter Wiring',
              slug: 'entity-system/storage-and-adapter-wiring',
            },
            {
              label: 'Generated Routes, Overrides, and Extra Routes',
              slug: 'entity-system/generated-routes-overrides-and-extra-routes',
            },
          ],
        },
        {
          label: 'Orchestration',
          badge: { text: 'Preview', variant: 'caution' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'orchestration/overview' },
            { label: 'Code-First Guide', slug: 'orchestration/code-first' },
            { label: 'Tasks and Workflows', slug: 'orchestration/tasks-and-workflows' },
            { label: 'Adapters', slug: 'orchestration/adapters' },
            { label: 'HTTP API', slug: 'orchestration/http-api' },
            { label: 'Events', slug: 'orchestration/events' },
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
            { label: 'Orchestration', slug: 'examples/orchestration' },
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
            { label: 'Overview', slug: 'guides' },
            { label: 'Security', slug: 'guides/security' },
            { label: 'Testing', slug: 'guides/testing' },
            { label: 'Error Handling', slug: 'guides/error-handling' },
            { label: 'Multi-Tenancy', slug: 'guides/multi-tenancy' },
            { label: 'Permissions', slug: 'guides/permissions' },
            { label: 'Deployment', slug: 'guides/deployment' },
            { label: 'Lambda', slug: 'guides/lambda' },
            { label: 'Runtime', slug: 'guides/runtime' },
            { label: 'Horizontal Scaling', slug: 'guides/horizontal-scaling' },
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'Observability', slug: 'guides/observability' },
            { label: 'Monitoring', slug: 'guides/monitoring' },
            { label: 'OpenAPI', slug: 'guides/openapi' },
            { label: 'Uploads', slug: 'guides/file-uploads' },
            { label: 'WebSockets', slug: 'guides/websockets' },
            { label: 'Webhook Governance', slug: 'guides/webhook-governance' },
            { label: 'Content Model', slug: 'guides/content-model' },
            { label: 'Migrate Community Plugin', slug: 'guides/migrate-community-plugin' },
            { label: 'Troubleshooting', slug: 'guides/troubleshooting' },
          ],
        },
        {
          label: 'Packages',
          collapsed: true,
          autogenerate: { directory: 'packages' },
        },
        {
          label: 'Alternate Paths',
          items: [
            { label: 'Overview', slug: 'alternate-paths' },
            { label: 'Manifest Authoring', slug: 'alternate-paths/manifest-authoring' },
            { label: 'Manifest vs Code', slug: 'manifest-vs-code' },
          ],
        },
        {
          label: 'Contributor Flows',
          collapsed: true,
          items: [
            { label: 'Framework Contributor', slug: 'agent-flows/framework-contributor' },
            { label: 'App Builder', slug: 'agent-flows/app-builder' },
          ],
        },
        {
          label: 'Plugin and Authoring Reference',
          collapsed: true,
          items: [
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
