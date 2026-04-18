import type { z } from 'zod';
import { BUILTIN_PLUGINS } from './builtinPlugins';

type SchemaLike = z.ZodType;
type SchemaLoader = () => Promise<SchemaLike | null>;

/**
 * Metadata for a registered built-in Slingshot plugin.
 */
export interface PluginSchemaEntry {
  readonly name: string;
  readonly package: string;
  readonly factory: string;
  readonly description: string;
  readonly category: string;
  readonly requires: readonly string[];
  readonly loadSchema: SchemaLoader;
}

async function loadSchemaExport(
  moduleSpecifier: string,
  exportName: string,
): Promise<SchemaLike | null> {
  try {
    const mod = (await import(moduleSpecifier)) as Record<string, unknown>;
    const schema = mod[exportName];
    return schema != null ? (schema as SchemaLike) : null;
  } catch {
    return null;
  }
}

const noSchema = (): Promise<null> => Promise.resolve(null);

export const PLUGIN_SCHEMA_ENTRIES = {
  'slingshot-auth': {
    name: 'slingshot-auth',
    package: BUILTIN_PLUGINS['slingshot-auth'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-auth'].factory,
    description:
      'Authentication plugin for Slingshot: sessions, JWTs, MFA, OAuth, WebAuthn, passkeys, auth middleware, and /auth routes.',
    category: 'security',
    requires: [],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-auth', 'authPluginConfigSchema'),
  },
  'slingshot-permissions': {
    name: 'slingshot-permissions',
    package: BUILTIN_PLUGINS['slingshot-permissions'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-permissions'].factory,
    description:
      'Policy engine for Slingshot grants, roles, and tenant-scoped permission evaluation.',
    category: 'security',
    requires: [],
    loadSchema: noSchema,
  },
  'slingshot-entity': {
    name: 'slingshot-entity',
    package: BUILTIN_PLUGINS['slingshot-entity'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-entity'].factory,
    description:
      'Config-driven entity plugin for Slingshot entities, operations, and generated CRUD routes.',
    category: 'data',
    requires: [],
    loadSchema: noSchema,
  },
  'slingshot-community': {
    name: 'slingshot-community',
    package: BUILTIN_PLUGINS['slingshot-community'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-community'].factory,
    description:
      'Community forum plugin for Slingshot with containers, threads, replies, reactions, and moderation.',
    category: 'engagement',
    requires: ['slingshot-entity', 'slingshot-notifications'],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-community', 'communityPluginConfigSchema'),
  },
  'slingshot-deep-links': {
    name: 'slingshot-deep-links',
    package: BUILTIN_PLUGINS['slingshot-deep-links'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-deep-links'].factory,
    description: 'Universal links, Android app links, and fallback redirects for Slingshot.',
    category: 'integrations',
    requires: [],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-deep-links', 'deepLinksConfigSchema'),
  },
  'slingshot-chat': {
    name: 'slingshot-chat',
    package: BUILTIN_PLUGINS['slingshot-chat'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-chat'].factory,
    description:
      'Real-time chat plugin with rooms, messages, membership, encryption hooks, and WebSocket event handling.',
    category: 'engagement',
    requires: ['slingshot-entity', 'slingshot-notifications', 'slingshot-permissions'],
    loadSchema: () =>
      loadSchemaExport('../../packages/slingshot-chat/src/config.schema', 'chatPluginConfigSchema'),
  },
  'slingshot-interactions': {
    name: 'slingshot-interactions',
    package: BUILTIN_PLUGINS['slingshot-interactions'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-interactions'].factory,
    description: 'Interactive message components and dispatch orchestration for Slingshot.',
    category: 'engagement',
    requires: ['slingshot-entity', 'slingshot-permissions'],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-interactions', 'interactionsPluginConfigSchema'),
  },
  'slingshot-ssr': {
    name: 'slingshot-ssr',
    package: BUILTIN_PLUGINS['slingshot-ssr'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-ssr'].factory,
    description:
      'SSR, ISR, and page-routing plugin for Slingshot with action handling and cache-aware rendering helpers.',
    category: 'frontend',
    requires: ['slingshot-entity'],
    loadSchema: () =>
      loadSchemaExport('../../packages/slingshot-ssr/src/config.schema', 'ssrPluginConfigSchema'),
  },
  'slingshot-image': {
    name: 'slingshot-image',
    package: BUILTIN_PLUGINS['slingshot-image'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-image'].factory,
    description:
      'On-the-fly image optimization plugin for route-mounted image delivery and caching.',
    category: 'media',
    requires: [],
    loadSchema: () =>
      loadSchemaExport(
        '../../packages/slingshot-image/src/config.schema',
        'imagePluginConfigSchema',
      ),
  },
  'slingshot-emoji': {
    name: 'slingshot-emoji',
    package: BUILTIN_PLUGINS['slingshot-emoji'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-emoji'].factory,
    description: 'Custom emoji management for Slingshot with entity-backed storage integration.',
    category: 'media',
    requires: ['slingshot-entity'],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-emoji', 'emojiPluginConfigSchema'),
  },
  'slingshot-embeds': {
    name: 'slingshot-embeds',
    package: BUILTIN_PLUGINS['slingshot-embeds'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-embeds'].factory,
    description: 'Server-side URL unfurling for Slingshot link previews.',
    category: 'media',
    requires: [],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-embeds', 'embedsPluginConfigSchema'),
  },
  'slingshot-gifs': {
    name: 'slingshot-gifs',
    package: BUILTIN_PLUGINS['slingshot-gifs'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-gifs'].factory,
    description: 'GIF search proxy for Slingshot with swappable upstream providers.',
    category: 'media',
    requires: [],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-gifs', 'gifsPluginConfigSchema'),
  },
  'slingshot-admin': {
    name: 'slingshot-admin',
    package: BUILTIN_PLUGINS['slingshot-admin'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-admin'].factory,
    description: 'Administrative routes and provider contracts for Slingshot operations tooling.',
    category: 'operations',
    requires: [],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-admin', 'adminPluginConfigSchema'),
  },
  'slingshot-assets': {
    name: 'slingshot-assets',
    package: BUILTIN_PLUGINS['slingshot-assets'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-assets'].factory,
    description:
      'Entity-driven asset storage plugin with storage adapters, upload metadata, and presigned URL support.',
    category: 'media',
    requires: ['slingshot-entity'],
    loadSchema: () =>
      loadSchemaExport(
        '../../packages/slingshot-assets/src/config.schema',
        'assetsPluginConfigSchema',
      ),
  },
  'slingshot-oauth': {
    name: 'slingshot-oauth',
    package: BUILTIN_PLUGINS['slingshot-oauth'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-oauth'].factory,
    description: 'Social OAuth login plugin for Slingshot.',
    category: 'security',
    requires: ['slingshot-auth'],
    loadSchema: noSchema,
  },
  'slingshot-oidc': {
    name: 'slingshot-oidc',
    package: BUILTIN_PLUGINS['slingshot-oidc'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-oidc'].factory,
    description: 'OIDC discovery and JWKS plugin for Slingshot.',
    category: 'security',
    requires: ['slingshot-auth'],
    loadSchema: noSchema,
  },
  'slingshot-m2m': {
    name: 'slingshot-m2m',
    package: BUILTIN_PLUGINS['slingshot-m2m'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-m2m'].factory,
    description: 'Machine-to-machine OAuth2 client-credentials plugin for Slingshot.',
    category: 'security',
    requires: ['slingshot-auth'],
    loadSchema: noSchema,
  },
  'slingshot-mail': {
    name: 'slingshot-mail',
    package: BUILTIN_PLUGINS['slingshot-mail'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-mail'].factory,
    description:
      'Transactional mail plugin with provider drivers, queue backends, and renderer integrations.',
    category: 'communication',
    requires: [],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-mail', 'mailPluginConfigSchema'),
  },
  'slingshot-notifications': {
    name: 'slingshot-notifications',
    package: BUILTIN_PLUGINS['slingshot-notifications'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-notifications'].factory,
    description: 'Shared notification storage, scheduling, and delivery events for Slingshot.',
    category: 'communication',
    requires: ['slingshot-entity'],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-notifications', 'notificationsPluginConfigSchema'),
  },
  'slingshot-organizations': {
    name: 'slingshot-organizations',
    package: BUILTIN_PLUGINS['slingshot-organizations'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-organizations'].factory,
    description: 'Organizations and groups management plugin for Slingshot.',
    category: 'operations',
    requires: ['slingshot-auth', 'slingshot-entity'],
    loadSchema: noSchema,
  },
  'slingshot-game-engine': {
    name: 'slingshot-game-engine',
    package: BUILTIN_PLUGINS['slingshot-game-engine'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-game-engine'].factory,
    description:
      'Multiplayer game state engine with config-driven phases, channels, turns, scoring, and replay.',
    category: 'engagement',
    requires: ['slingshot-entity'],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-game-engine', 'GameEnginePluginConfigSchema'),
  },
  'slingshot-polls': {
    name: 'slingshot-polls',
    package: BUILTIN_PLUGINS['slingshot-polls'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-polls'].factory,
    description: 'Multiple-choice polls attachable to user content in Slingshot.',
    category: 'engagement',
    requires: ['slingshot-entity'],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-polls', 'PollsPluginConfigSchema'),
  },
  'slingshot-push': {
    name: 'slingshot-push',
    package: BUILTIN_PLUGINS['slingshot-push'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-push'].factory,
    description: 'Multi-provider push delivery plugin for Slingshot.',
    category: 'communication',
    requires: ['slingshot-entity', 'slingshot-notifications'],
    loadSchema: () => loadSchemaExport('@lastshotlabs/slingshot-push', 'pushPluginConfigSchema'),
  },
  'slingshot-scim': {
    name: 'slingshot-scim',
    package: BUILTIN_PLUGINS['slingshot-scim'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-scim'].factory,
    description: 'SCIM 2.0 user provisioning plugin for Slingshot.',
    category: 'security',
    requires: ['slingshot-auth'],
    loadSchema: noSchema,
  },
  'slingshot-search': {
    name: 'slingshot-search',
    package: BUILTIN_PLUGINS['slingshot-search'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-search'].factory,
    description: 'Per-entity search plugin for Slingshot with pluggable search backends.',
    category: 'data',
    requires: [],
    loadSchema: () =>
      loadSchemaExport(
        '../../packages/slingshot-search/src/types/config',
        'searchPluginConfigSchema',
      ),
  },
  'slingshot-webhooks': {
    name: 'slingshot-webhooks',
    package: BUILTIN_PLUGINS['slingshot-webhooks'].pkg,
    factory: BUILTIN_PLUGINS['slingshot-webhooks'].factory,
    description:
      'Inbound and outbound webhook plugin with signature helpers and queue-backed delivery.',
    category: 'integrations',
    requires: ['slingshot-entity'],
    loadSchema: () =>
      loadSchemaExport('@lastshotlabs/slingshot-webhooks', 'webhookPluginConfigSchema'),
  },
} as const satisfies Record<string, PluginSchemaEntry>;

export function loadPluginSchema(name: string): Promise<SchemaLike | null> {
  const entries = PLUGIN_SCHEMA_ENTRIES as Record<string, PluginSchemaEntry | undefined>;
  const entry = entries[name];
  if (!entry) return Promise.resolve(null);
  return entry.loadSchema();
}

export function listPlugins(): PluginSchemaEntry[] {
  return Object.values(PLUGIN_SCHEMA_ENTRIES).sort((a, b) => a.name.localeCompare(b.name));
}
