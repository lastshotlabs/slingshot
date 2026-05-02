import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

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
    resolve: {},
  },
  integrations: [
    starlight({
      title: 'Slingshot',
      disable404Route: true,
      description:
        'Composable Slingshot packages for app assembly, package-first authoring, entities, events, realtime, and platform tooling',
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        Head: './src/components/Head.astro',
        Sidebar: './src/components/Sidebar.astro',
      },
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
          label: 'Start Here',
          items: [
            { label: 'Overview', slug: 'getting-started' },
            { label: 'First Steps', slug: 'first-steps' },
            { label: 'Quick Start', slug: 'quick-start' },
            { label: 'Installation', slug: 'installation' },
            { label: 'FAQ', slug: 'faq' },
          ],
        },
        {
          label: 'Composing an App',
          items: [
            { label: 'App Config', slug: 'app-authoring/app-config' },
            { label: 'Packages', slug: 'package-first/define-package' },
            { label: 'Domains and Routes', slug: 'package-first/domain-and-route' },
            { label: 'Capabilities and entityRef', slug: 'package-first/capabilities-and-entity-ref' },
            { label: 'Events and the Event Bus', slug: 'app-authoring/events-and-the-event-bus' },
            { label: 'Escape Hatches', slug: 'package-first/escape-hatches' },
          ],
        },
        {
          label: 'Authoring Routes',
          items: [
            { label: 'Routes and Handlers', slug: 'app-authoring/routes-and-handlers' },
            { label: 'Validation', slug: 'app-authoring/validation' },
            { label: 'DTO Mapping', slug: 'app-authoring/dto-mapping' },
            { label: 'Route Policy', slug: 'entity-system/route-policy' },
            { label: 'Middleware', slug: 'app-authoring/middleware' },
            { label: 'Exception Handling', slug: 'app-authoring/exception-handling' },
            { label: 'Context and Actors', slug: 'app-authoring/context-and-request-model' },
            { label: 'Context and Actor Helpers', slug: 'app-authoring/context-helpers' },
            { label: 'Pagination', slug: 'app-authoring/pagination' },
            { label: 'Idempotent Requests', slug: 'app-authoring/idempotency' },
            { label: 'Request IDs', slug: 'app-authoring/request-ids' },
            { label: 'API Versioning', slug: 'app-authoring/api-versioning' },
            { label: 'OpenAPI', slug: 'guides/openapi' },
          ],
        },
        {
          label: 'Working with Data',
          items: [
            { label: 'Data and Entities', slug: 'core-features/data-and-entities' },
            { label: 'defineEntity', slug: 'entity-system/define-entity' },
            { label: 'Operations', slug: 'entity-system/operations' },
            { label: 'Storage and Adapters', slug: 'entity-system/storage-and-adapter-wiring' },
            {
              label: 'Generated Routes, Overrides, and Extra Routes',
              slug: 'entity-system/generated-routes-overrides-and-extra-routes',
            },
          ],
        },
        {
          label: 'Security',
          items: [
            {
              label: 'Authentication',
              slug: 'core-features/auth',
              badge: { text: 'Experimental', variant: 'caution' },
            },
            {
              label: 'Authorization',
              slug: 'core-features/permissions',
              badge: { text: 'Prod path', variant: 'tip' },
            },
            { label: 'Rate Limiting', slug: 'app-authoring/rate-limiting' },
            { label: 'Cookies', slug: 'app-authoring/cookies' },
            { label: 'Encryption and Hashing', slug: 'app-authoring/encryption-and-hashing' },
            { label: 'Security Headers', slug: 'app-authoring/security-headers' },
            { label: 'Request Signing & Webhook Auth', slug: 'app-authoring/request-signing' },
            { label: 'Permissions Guide', slug: 'guides/permissions' },
            { label: 'Multi-Tenancy', slug: 'guides/multi-tenancy' },
            { label: 'Security Hardening', slug: 'guides/security' },
          ],
        },
        {
          label: 'Realtime',
          items: [
            { label: 'Realtime Overview', slug: 'core-features/realtime' },
            { label: 'WebSockets', slug: 'app-authoring/websockets' },
            { label: 'WebSocket Presence', slug: 'app-authoring/websocket-presence' },
            { label: 'WebSocket Recovery', slug: 'app-authoring/websocket-recovery' },
            { label: 'WebSocket Transports', slug: 'app-authoring/websocket-transports' },
            { label: 'Server-Sent Events', slug: 'app-authoring/server-sent-events' },
            { label: 'WebSockets Guide', slug: 'guides/websockets' },
          ],
        },
        {
          label: 'Operations',
          items: [
            {
              label: 'Background Jobs',
              slug: 'core-features/jobs-and-orchestration',
              badge: { text: 'Prod path', variant: 'tip' },
            },
            { label: 'Cron and Background Workers', slug: 'app-authoring/cron-and-workers' },
            { label: 'Health Checks', slug: 'app-authoring/health-checks' },
            { label: 'Structured Logging', slug: 'app-authoring/logging' },
            { label: 'Response Caching', slug: 'app-authoring/caching' },
            { label: 'Audit Logging', slug: 'app-authoring/audit-logging' },
            { label: 'Metrics & Prometheus', slug: 'app-authoring/metrics' },
            { label: 'Distributed Tracing', slug: 'app-authoring/distributed-tracing' },
            { label: 'Observability', slug: 'guides/observability' },
            { label: 'Monitoring', slug: 'guides/monitoring' },
            { label: 'Error Handling', slug: 'guides/error-handling' },
          ],
        },
        {
          label: 'Production',
          items: [
            { label: 'Production Readiness', slug: 'guides/production-readiness' },
            { label: 'Deployment', slug: 'guides/deployment' },
            { label: 'Runtime Selection', slug: 'guides/runtime' },
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'Horizontal Scaling', slug: 'guides/horizontal-scaling' },
            { label: 'File Uploads', slug: 'guides/file-uploads' },
            { label: 'Webhooks', slug: 'guides/webhooks' },
            { label: 'Webhook Governance', slug: 'guides/webhook-governance' },
            { label: 'Transactional Mail', slug: 'guides/mail' },
            { label: 'Admin Surface', slug: 'guides/admin' },
            { label: 'Content Model', slug: 'guides/content-model' },
            { label: 'Migrate Community Plugin', slug: 'guides/migrate-community-plugin' },
            { label: 'Troubleshooting', slug: 'guides/troubleshooting' },
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
          label: 'Orchestration Reference',
          badge: { text: 'Prod path', variant: 'tip' },
          collapsed: true,
          items: [
            { label: 'Overview', slug: 'orchestration/overview' },
            { label: 'Code-First Guide', slug: 'orchestration/guide' },
            { label: 'Tasks and Workflows', slug: 'orchestration/tasks-and-workflows' },
            { label: 'Adapters', slug: 'orchestration/adapters' },
            { label: 'HTTP API', slug: 'orchestration/http-api' },
            { label: 'Events', slug: 'orchestration/events' },
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
            { label: 'Testing Apps', slug: 'guides/testing' },
            { label: 'Publishing', slug: 'authoring/publishing' },
            { label: 'createServer and createApp', slug: 'app-authoring/create-server-and-create-app' },
            { label: 'Runtime and Infrastructure', slug: 'app-authoring/runtime-and-infrastructure' },
            { label: 'Starter App', slug: 'app-authoring/starter-app' },
            { label: 'OpenAPI and Validation Reference', slug: 'app-authoring/openapi-and-validation' },
            {
              label: 'Maturity and Package Status',
              slug: 'core-features/maturity-and-package-status',
            },
            { label: 'Authoring Model Overview', slug: 'authoring-model' },
            { label: 'App Roots and Runtime Overview', slug: 'app-authoring' },
            { label: 'Package-First Overview', slug: 'package-first' },
            { label: 'Entity System Overview', slug: 'entity-system' },
            { label: 'Advanced Overview', slug: 'advanced' },
            { label: 'Advanced Escape Hatches', slug: 'advanced/escape-hatches' },
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
            { label: 'Secrets', slug: 'internals/secrets' },
          ],
        },
        {
          label: 'Packages',
          collapsed: true,
          autogenerate: { directory: 'packages' },
        },
        {
          label: 'Workflow Guides',
          collapsed: true,
          items: [
            { label: 'App Builder', slug: 'agent-flows/app-builder' },
            { label: 'Framework Contributor', slug: 'agent-flows/framework-contributor' },
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
