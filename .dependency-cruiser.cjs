/** @type {import('dependency-cruiser').IConfiguration} */
const FOUNDATION_PACKAGES = 'slingshot-(?:core|entity|auth|permissions|postgres|bullmq|ssr)';
const FEATURE_PACKAGE_PATH = `^packages/(slingshot-(?!(?:core|entity|auth|permissions|postgres|bullmq|ssr)(?:/|$))[^/]+)/`;
const FOUNDATION_PACKAGE_PATH = `^packages/(${FOUNDATION_PACKAGES})/`;
const NON_AUTH_EXTENSION_PACKAGE_PATH = `^packages/(slingshot-(?!(?:auth|oauth|oidc|scim|m2m)(?:/|$))[^/]+)/`;

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Circular dependencies make code harder to reason about and can cause subtle bugs.',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Feature plugins may depend on foundation packages (core, auth, entity, permissions, etc.) ' +
        'but must not import other feature plugins directly. ' +
        'Peer coordination belongs in ctx.pluginState with neutral contracts in core.',
      from: {
        path: FEATURE_PACKAGE_PATH,
      },
      to: {
        path: FEATURE_PACKAGE_PATH,
        pathNot: '^packages/$1/',
      },
    },
    {
      name: 'no-foundation-to-feature',
      severity: 'error',
      comment:
        'Foundation packages define shared contracts and lower-level primitives. ' +
        'They must not reach upward into feature plugins.',
      from: {
        path: FOUNDATION_PACKAGE_PATH,
      },
      to: {
        path: FEATURE_PACKAGE_PATH,
      },
    },
    {
      name: 'no-non-auth-package-to-auth',
      severity: 'error',
      comment:
        'Only auth-adjacent packages may import slingshot-auth directly. ' +
        'Other packages must consume neutral contracts from slingshot-core or read auth runtime state ' +
        "through ctx.pluginState.get('slingshot-auth').",
      from: {
        path: NON_AUTH_EXTENSION_PACKAGE_PATH,
      },
      to: {
        path: '^packages/slingshot-auth/',
      },
    },
    {
      name: 'no-plugin-to-framework-root',
      severity: 'error',
      comment:
        'Plugins must not import framework root internals. ' +
        'If a plugin needs something beyond core, the contract belongs in core or should be injected via config/providers.',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^src/',
      },
    },
  ],
  options: {
    includeOnly: {
      path: '^(src/|packages/[^/]+/src/).+\\.(ts|tsx)$',
    },
    exclude: {
      path: '(^|/)(dist|\\.tmp|coverage)(/|$)|\\.d\\.ts$',
    },
    doNotFollow: {
      path: 'node_modules|(^|/)(dist|\\.tmp)(/|$)|^packages/docs/dist/',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
