export interface CodeAppCheck {
  kind: 'code-app';
  entrypoint: string;
}

export interface ModuleExportsCheck {
  kind: 'module-exports';
  entrypoint: string;
  exports: string[];
  requiredPlugins?: string[];
}

export type ExampleCheckDefinition = CodeAppCheck | ModuleExportsCheck;

export interface ExampleDefinition {
  name: string;
  directory: string;
  docsPath: string;
  checks: ExampleCheckDefinition[];
}

export const exampleRegistry: ExampleDefinition[] = [
  {
    name: 'with-auth',
    directory: 'examples/with-auth',
    docsPath: 'packages/docs/src/content/docs/examples/with-auth.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/with-auth/app.config.ts' }],
  },
  {
    name: 'config-driven-domain',
    directory: 'examples/config-driven-domain',
    docsPath: 'packages/docs/src/content/docs/examples/config-driven-domain.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/config-driven-domain/app.config.ts' }],
  },
  {
    name: 'collaboration-workspace',
    directory: 'examples/collaboration-workspace',
    docsPath: 'packages/docs/src/content/docs/examples/collaboration-workspace.mdx',
    checks: [
      {
        kind: 'module-exports',
        entrypoint: 'examples/collaboration-workspace/app.config.ts',
        exports: ['default'],
        requiredPlugins: [
          'slingshot-auth',
          'slingshot-notifications',
          'slingshot-permissions',
          'slingshot-community',
          'slingshot-chat',
          'slingshot-polls',
          'slingshot-assets',
          'slingshot-emoji',
          'slingshot-embeds',
          'slingshot-gifs',
          'slingshot-deep-links',
          'slingshot-interactions',
        ],
      },
    ],
  },
  {
    name: 'content-platform',
    directory: 'examples/content-platform',
    docsPath: 'packages/docs/src/content/docs/examples/content-platform.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/content-platform/app.config.ts' }],
  },
  {
    name: 'game-engine',
    directory: 'examples/game-engine',
    docsPath: 'packages/docs/src/content/docs/examples/game-engine.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/game-engine/app.config.ts' }],
  },
  {
    name: 'orchestration',
    directory: 'examples/orchestration',
    docsPath: 'packages/docs/src/content/docs/examples/orchestration.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/orchestration/app.config.ts' }],
  },
  {
    name: 'orchestration-bullmq',
    directory: 'examples/orchestration-bullmq',
    docsPath: 'packages/docs/src/content/docs/examples/orchestration-bullmq.mdx',
    checks: [
      {
        kind: 'module-exports',
        entrypoint: 'examples/orchestration-bullmq/app.config.ts',
        exports: ['default', 'requireOpsKey', 'resolveOpsRequestContext'],
      },
    ],
  },
  {
    name: 'organizations',
    directory: 'examples/organizations',
    docsPath: 'packages/docs/src/content/docs/examples/organizations.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/organizations/app.config.ts' }],
  },
  {
    name: 'webhooks',
    directory: 'examples/webhooks',
    docsPath: 'packages/docs/src/content/docs/examples/webhooks.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/webhooks/app.config.ts' }],
  },
];
