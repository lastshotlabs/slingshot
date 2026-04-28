export interface CodeAppCheck {
  kind: 'code-app';
  entrypoint: string;
}

export interface ManifestCheck {
  kind: 'manifest';
  manifestPath: string;
  handlerModule?: string;
  handlerExports?: string[];
}

export interface ModuleExportsCheck {
  kind: 'module-exports';
  entrypoint: string;
  exports: string[];
  requiredPlugins?: string[];
}

export type ExampleCheckDefinition = CodeAppCheck | ManifestCheck | ModuleExportsCheck;

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
    checks: [
      { kind: 'code-app', entrypoint: 'examples/with-auth/src/index.ts' },
      { kind: 'manifest', manifestPath: 'examples/with-auth/app.manifest.json' },
    ],
  },
  {
    name: 'config-driven-domain',
    directory: 'examples/config-driven-domain',
    docsPath: 'packages/docs/src/content/docs/examples/config-driven-domain.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/config-driven-domain/src/index.ts' }],
  },
  {
    name: 'collaboration-workspace',
    directory: 'examples/collaboration-workspace',
    docsPath: 'packages/docs/src/content/docs/examples/collaboration-workspace.mdx',
    checks: [
      {
        kind: 'module-exports',
        entrypoint: 'examples/collaboration-workspace/src/index.ts',
        exports: ['buildAppConfig'],
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
      {
        kind: 'manifest',
        manifestPath: 'examples/collaboration-workspace/app.manifest.json',
      },
    ],
  },
  {
    name: 'content-platform',
    directory: 'examples/content-platform',
    docsPath: 'packages/docs/src/content/docs/examples/content-platform.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/content-platform/src/index.ts' }],
  },
  {
    name: 'game-engine',
    directory: 'examples/game-engine',
    docsPath: 'packages/docs/src/content/docs/examples/game-engine.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/game-engine/src/index.ts' }],
  },
  {
    name: 'orchestration',
    directory: 'examples/orchestration',
    docsPath: 'packages/docs/src/content/docs/examples/orchestration.mdx',
    checks: [{ kind: 'code-app', entrypoint: 'examples/orchestration/src/index.ts' }],
  },
  {
    name: 'orchestration-bullmq',
    directory: 'examples/orchestration-bullmq',
    docsPath: 'packages/docs/src/content/docs/examples/orchestration-bullmq.mdx',
    checks: [
      {
        kind: 'module-exports',
        entrypoint: 'examples/orchestration-bullmq/src/index.ts',
        exports: ['buildAppConfig', 'requireOpsKey', 'resolveOpsRequestContext'],
      },
      {
        kind: 'manifest',
        manifestPath: 'examples/orchestration-bullmq/app.manifest.json',
        handlerModule: 'examples/orchestration-bullmq/src/index.ts',
        handlerExports: ['requireOpsKey', 'resolveOpsRequestContext'],
      },
    ],
  },
  {
    name: 'organizations',
    directory: 'examples/organizations',
    docsPath: 'packages/docs/src/content/docs/examples/organizations.mdx',
    checks: [
      { kind: 'code-app', entrypoint: 'examples/organizations/src/index.ts' },
      { kind: 'manifest', manifestPath: 'examples/organizations/app.manifest.json' },
    ],
  },
  {
    name: 'webhooks',
    directory: 'examples/webhooks',
    docsPath: 'packages/docs/src/content/docs/examples/webhooks.mdx',
    checks: [
      { kind: 'code-app', entrypoint: 'examples/webhooks/src/index.ts' },
      { kind: 'manifest', manifestPath: 'examples/webhooks/app.manifest.json' },
    ],
  },
];
