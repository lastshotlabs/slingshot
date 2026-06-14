/**
 * Community package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts all 19 community
 * entities (Container, Thread, Reply, Reaction, ContainerMember,
 * ContainerRule, Report, Ban, Tag, ThreadTag, ContainerInvite,
 * ContainerSubscription, ThreadSubscription, UserMute, Bookmark,
 * AutoModRule, Warning, AuditLogEntry, ContainerSetting), wires adapter-
 * dependent middleware (banCheck, autoMod, threadStateGuard, banNotify,
 * containerCreationGuard, grantManager, …), publishes the
 * `CommunityInteractionsPeerCap` capability, and registers push formatters.
 *
 * Every adapter ref, middleware closure, and lazy ref is owned by the
 * factory's closure (Rule 3) — multiple package instances in the same
 * process do not share state.
 */
import type { MiddlewareHandler } from 'hono';
import type {
  NotificationRecord,
  PermissionsState,
  PluginSetupContext,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  PERMISSIONS_STATE_KEY,
  deepFreeze,
  defineEvent,
  definePackage,
  getActor,
  getContext,
  getPermissionsStateOrNull,
  getPluginStateOrNull,
  parseBody,
  provideCapability,
  publishPluginState,
  readPluginState,
  resolveCapabilityValue,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createLazyMiddleware } from '@lastshotlabs/slingshot-entity';
import { NotificationsBuilderFactoryCap } from '@lastshotlabs/slingshot-notifications';
import { PushFormatterRegistryCap } from '@lastshotlabs/slingshot-push';
import { buildCommunityEntityModules } from './entities/modules';
import type { CommunityAdapterRefs, RedeemPermissionsAdapter } from './entities/runtime';
import { notifyMentions } from './lib/mentions';
import type { NotifyMentionsDeps } from './lib/mentions';
import { extractUrls } from './lib/urls';
import { createAuditLogMiddleware } from './middleware/auditLog';
import { createAutoModMiddleware } from './middleware/autoMod';
import { createBanCheckMiddleware } from './middleware/banCheck';
import { createBanNotifyMiddleware } from './middleware/banNotify';
import { createContainerCreationGuardMiddleware } from './middleware/containerCreationGuard';
import { createContainerCreatorGrantMiddleware } from './middleware/containerCreatorGrant';
import { createContentTargetGuardMiddleware } from './middleware/contentTargetGuard';
import { createGrantManagerMiddleware } from './middleware/grantManager';
import { createMemberJoinGuardMiddleware } from './middleware/memberJoinGuard';
import { createMemberJoinPolicyGuardMiddleware } from './middleware/memberJoinPolicyGuard';
import { buildAttachmentRequiredGuard, buildPollRequiredGuard } from './middleware/peerGuards';
import { createPublishedThreadGuardMiddleware } from './middleware/publishedThreadGuard';
import { createReplyCountDecrementMiddleware } from './middleware/replyCountDecrement';
import { createReplyCountUpdateMiddleware } from './middleware/replyCountUpdate';
import { createRoleAssignmentGuardMiddleware } from './middleware/roleAssignmentGuard';
import { createSolutionReplyGuardMiddleware } from './middleware/solutionReplyGuard';
import { createThreadStateGuardMiddleware } from './middleware/threadStateGuard';
import { probeEmbedsPeer } from './peers/embeds';
import { CommunityInteractionsPeerCap } from './public';
import type { CommunityInteractionsPeer } from './public';
import { DEFAULT_SCORING_CONFIG } from './types/config';
import type { CommunityPluginConfig } from './types/config';
import { communityPluginConfigSchema } from './types/config';
import { COMMUNITY_PLUGIN_STATE_KEY, CommunityPluginStateRef } from './types/state';

function hasBusOn(bus: unknown): bus is {
  on(event: string, handler: (payload: Record<string, unknown>) => void | Promise<void>): void;
} {
  return bus != null && typeof (bus as Record<string, unknown>).on === 'function';
}

function toNotificationText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
}

function notificationData(notification: NotificationRecord): Record<string, unknown> {
  return notification.data && typeof notification.data === 'object' ? notification.data : {};
}

/**
 * Build the cross-package interactions peer from adapter refs.
 *
 * The closure captures the refs bag, so it always reflects the latest
 * resolved adapters — even though the peer is built before the package's
 * entity modules have run `wiring.buildAdapter`.
 */
function buildInteractionsPeer(refs: CommunityAdapterRefs): CommunityInteractionsPeer {
  return {
    peerKind: 'community',
    async resolveMessageByKindAndId(kind, id) {
      if (kind === 'community:thread') {
        return (await refs.thread?.getById(id)) ?? null;
      }
      if (kind === 'community:reply') {
        return (await refs.reply?.getById(id)) ?? null;
      }
      return null;
    },
    async updateComponents(kind, id, components) {
      if (kind === 'community:thread') {
        if (refs.thread) {
          await refs.thread.updateComponents({ id }, { components });
        }
        return;
      }
      if (kind === 'community:reply') {
        if (refs.reply) {
          await refs.reply.updateComponents({ id }, { components });
        }
      }
    },
  };
}

/**
 * Create the community package using the `definePackage` authoring path.
 *
 * Wires all 19 community entities — each entity module uses
 * `wiring: { mode: 'manual', buildAdapter }` so the package factory can
 * capture the resolved adapter into a closure-owned {@link CommunityAdapterRefs}
 * bag for adapter-dependent middleware and event subscribers.
 *
 * **Cross-package contracts:**
 * - Requires `slingshot-permissions` for `PermissionsState`.
 * - Requires `slingshot-notifications` for `NotificationsBuilderFactoryCap`.
 * - Publishes `CommunityInteractionsPeerCap` for consumers (notably
 *   `slingshot-interactions`).
 *
 * **Optional integrations (duck-typed):**
 * - `slingshot-push` — when present, registers push formatters for community
 *   notification types.
 * - `slingshot-embeds` — when present, unfurls links in thread/reply bodies
 *   and writes the resolved embeds back via `attachEmbeds`.
 *
 * @param rawConfig - Package configuration. Validated at construction time.
 * @returns A `SlingshotPackageDefinition` suitable for `createApp({ packages: [...] })`.
 *
 * @throws {Error} If `rawConfig` fails Zod schema validation.
 * @throws {Error} If `PermissionsState` is absent when `setupMiddleware` runs.
 * @throws {Error} If `NotificationsBuilderFactoryCap` is unavailable when
 *   `setupPost` runs.
 */
export function createCommunityPackage(
  rawConfig: CommunityPluginConfig,
): SlingshotPackageDefinition {
  const config = deepFreeze(
    validatePluginConfig('slingshot-community', rawConfig, communityPluginConfigSchema),
  );

  // The `scoring` config is parsed and frozen here purely for validation —
  // the dormant reaction `updateScore` op.custom in the entity has no HTTP
  // route and no caller, so no runtime wiring consumes it. Read it once to
  // make the dependence on `DEFAULT_SCORING_CONFIG` explicit.
  void (config.scoring ?? DEFAULT_SCORING_CONFIG);

  // Closure-owned adapter refs populated by each entity module's
  // `wiring.buildAdapter` during bootstrap (Rule 3 — no globals).
  const refs: CommunityAdapterRefs = {};

  // Lazy middleware refs — all start as no-ops. Adapter-dependent refs
  // (banCheck, autoMod, threadStateGuard, banNotify, etc.) are populated
  // inside `setupPost` once entity adapters have been captured. Permission-
  // dependent refs (containerCreationGuard, grantManager) are populated in
  // `setupMiddleware` once permissions are resolved.
  const banCheckRef = createLazyMiddleware();
  const autoModRef = createLazyMiddleware();
  const threadStateGuardRef = createLazyMiddleware();
  const publishedThreadGuardRef = createLazyMiddleware();
  const targetVisibilityGuardRef = createLazyMiddleware();
  const reportTargetGuardRef = createLazyMiddleware();
  const memberJoinPolicyGuardRef = createLazyMiddleware();
  const solutionReplyGuardRef = createLazyMiddleware();
  const banNotifyRef = createLazyMiddleware();
  const containerCreationGuardRef = createLazyMiddleware();
  const containerCreatorGrantRef = createLazyMiddleware();
  const grantManagerRef = createLazyMiddleware();
  const replyCountUpdateRef = createLazyMiddleware();
  const replyCountDecrementRef = createLazyMiddleware();
  const auditLogRef = createLazyMiddleware();

  // Permissions resolved in setupMiddleware — used for adapter wiring later.
  let permissionsRef: PermissionsState | undefined;
  let notificationsBuilderFactoryRef:
    | ((opts: { source: string }) => import('@lastshotlabs/slingshot-core').NotificationBuilder)
    | undefined;

  // Cross-package interactions peer — built once, captures `refs` by closure
  // so it always sees the latest adapters.
  const interactionsPeer = buildInteractionsPeer(refs);

  // ─── Permissions probe + admission adapter (used by redeemInvite) ──────────
  // The redeemInvite handler needs a permissions adapter at module-build time
  // (entity modules are built before `setupMiddleware` runs). We expose a
  // delegating wrapper whose target is filled in inside `setupMiddleware`.
  const permissionsAdapterRef: { current?: PermissionsState['adapter'] } = {};
  const permissionsAdapterProxy: RedeemPermissionsAdapter = {
    createGrant: input => {
      if (!permissionsAdapterRef.current) {
        throw new Error(
          '[slingshot-community] Permissions adapter accessed before setupMiddleware resolved it',
        );
      }
      return permissionsAdapterRef.current.createGrant(input);
    },
  };

  // Build entity modules eagerly — `definePackage` needs the entities up-front.
  const entityModules = buildCommunityEntityModules({
    refs,
    permissionsAdapter: permissionsAdapterProxy,
  });

  const entities = [
    entityModules.containerModule,
    entityModules.threadModule,
    entityModules.replyModule,
    entityModules.reactionModule,
    entityModules.containerMemberModule,
    entityModules.containerRuleModule,
    entityModules.reportModule,
    entityModules.banModule,
    entityModules.tagModule,
    entityModules.threadTagModule,
    entityModules.containerInviteModule,
    entityModules.containerSubscriptionModule,
    entityModules.threadSubscriptionModule,
    entityModules.userMuteModule,
    entityModules.bookmarkModule,
    entityModules.autoModRuleModule,
    entityModules.warningModule,
    entityModules.auditLogEntryModule,
    entityModules.containerSettingModule,
  ];

  // Named middleware map referenced by entity routes (entity middleware names
  // → handlers). The framework copies this map into the entity-plugin at
  // boot, so each entry must close over a stable ref the framework re-reads
  // at request time.
  function buildMiddleware(): Record<string, MiddlewareHandler> {
    return {
      banCheck: async (c, next) => banCheckRef.handler(c, next),
      autoMod: async (c, next) => autoModRef.handler(c, next),
      threadStateGuard: async (c, next) => threadStateGuardRef.handler(c, next),
      publishedThreadGuard: async (c, next) => publishedThreadGuardRef.handler(c, next),
      targetVisibilityGuard: async (c, next) => targetVisibilityGuardRef.handler(c, next),
      reportTargetGuard: async (c, next) => reportTargetGuardRef.handler(c, next),
      memberJoinPolicyGuard: async (c, next) => memberJoinPolicyGuardRef.handler(c, next),
      solutionReplyGuard: async (c, next) => solutionReplyGuardRef.handler(c, next),
      auditLog: async (c, next) => auditLogRef.handler(c, next),
      grantManager: async (c, next) => grantManagerRef.handler(c, next),
      containerCreationGuard: async (c, next) => containerCreationGuardRef.handler(c, next),
      containerCreatorGrant: async (c, next) => containerCreatorGrantRef.handler(c, next),
      banNotify: async (c, next) => banNotifyRef.handler(c, next),
      memberJoinGuard: createMemberJoinGuardMiddleware(),
      // roleAssignmentGuard + pollRequiredGuard + attachmentRequiredGuard
      // need `app`/`permissions` at build time, so they're materialised in
      // `setupMiddleware` and re-assigned via these refs.
      roleAssignmentGuard: async (c, next) => roleAssignmentGuardRef.handler(c, next),
      pollRequiredGuard: async (c, next) => pollRequiredGuardRef.handler(c, next),
      attachmentRequiredGuard: async (c, next) => attachmentRequiredGuardRef.handler(c, next),
      replyCountUpdate: async (c, next) => replyCountUpdateRef.handler(c, next),
      replyCountDecrement: async (c, next) => replyCountDecrementRef.handler(c, next),
    };
  }

  // App-dependent middleware refs (built once `app` is on hand).
  const roleAssignmentGuardRef = createLazyMiddleware();
  const pollRequiredGuardRef = createLazyMiddleware();
  const attachmentRequiredGuardRef = createLazyMiddleware();

  return definePackage({
    name: COMMUNITY_PLUGIN_STATE_KEY,
    mountPath: config.mountPath ?? '/community',
    dependencies: ['slingshot-auth', 'slingshot-notifications', 'slingshot-permissions'],
    entities,
    middleware: buildMiddleware(),
    capabilities: {
      provides: [provideCapability(CommunityInteractionsPeerCap, () => interactionsPeer)],
    },

    async setupMiddleware({ app, events }: PluginSetupContext) {
      if (!events.get('community:thread.embeds.resolved')) {
        events.register(
          defineEvent('community:thread.embeds.resolved', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                actorId: null,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }
      if (!events.get('community:reply.embeds.resolved')) {
        events.register(
          defineEvent('community:reply.embeds.resolved', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                tenantId: payload.tenantId ?? null,
                actorId: null,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }
      if (!events.get('community:invite.redeemed')) {
        events.register(
          defineEvent('community:invite.redeemed', {
            ownerPlugin: COMMUNITY_PLUGIN_STATE_KEY,
            exposure: ['client-safe'],
            resolveScope(payload) {
              return {
                userId: payload.userId,
                actorId: payload.userId,
                resourceType: 'community:container',
                resourceId: payload.containerId,
              };
            },
          }),
        );
      }

      // Auto-bridge auth context to community principal when configured.
      if (config.authBridge === 'auto') {
        const mountPath = config.mountPath ?? '/community';
        app.use(`${mountPath}/*`, async (c, next) => {
          const actor = getActor(c);
          const rolesValue = actor.roles;
          const roles = Array.isArray(rolesValue)
            ? rolesValue.filter((role): role is string => typeof role === 'string')
            : [];
          if (actor.id) {
            // The framework's typed `c.set` only accepts keys declared in
            // its global `AppVariables` map. The community plugin's
            // `communityPrincipal` slot lives in `CommunityEnv` and is not
            // merged into `AppVariables` (other plugins use the same trick).
            // Narrow back to the structural `set(key, value)` Hono exposes.
            (c as unknown as { set(key: string, value: unknown): void }).set('communityPrincipal', {
              subject: actor.id,
              roles,
            });
          }
          await next();
        });
      }

      const pluginState = getPluginStateOrNull(app);
      const permissions: PermissionsState =
        getPermissionsStateOrNull(app) ??
        (() => {
          throw new Error(
            '[slingshot-community] No permissions available. Register createPermissionsPackage() before this plugin.',
          );
        })();

      permissionsRef = permissions;
      permissionsAdapterRef.current = permissions.adapter;

      if (pluginState) {
        if (!pluginState.has(PERMISSIONS_STATE_KEY)) {
          publishPluginState(pluginState, PERMISSIONS_STATE_KEY, permissions);
        }
        // Merge so we don't clobber other keys (entityAdapters published by
        // the framework's entity-plugin path).
        const existing = readPluginState(pluginState, CommunityPluginStateRef);
        publishPluginState(pluginState, CommunityPluginStateRef, {
          ...(existing ?? {}),
          config,
          evaluator: permissions.evaluator,
          interactionsPeer,
        });
      }

      // Permission-dependent middleware refs (now that permissions are resolved).
      containerCreationGuardRef.handler = createContainerCreationGuardMiddleware({
        containerCreation: config.containerCreation,
        permissionEvaluator: permissions.evaluator,
      });
      grantManagerRef.handler = createGrantManagerMiddleware({
        permissionsAdapter: permissions.adapter,
        getMemberById: async memberId => {
          if (!refs.member) return null;
          const result = await refs.member.getById(memberId);
          if (!result) return null;
          return {
            role: typeof result.role === 'string' ? result.role : undefined,
            userId: typeof result.userId === 'string' ? result.userId : undefined,
            containerId: typeof result.containerId === 'string' ? result.containerId : undefined,
          };
        },
      });
      // Container creator grant: lazily wired against `refs.member` which the
      // entity-plugin populates inside its `setupRoutes`. The wrapper closes
      // over the ref, not the adapter — so by the time a request hits, the
      // captured adapter is in place.
      containerCreatorGrantRef.handler = createContainerCreatorGrantMiddleware({
        permissionsAdapter: permissions.adapter,
        memberAdapter: {
          create: async input => {
            if (!refs.member) {
              throw new Error(
                '[slingshot-community] ContainerMember adapter unavailable when issuing creator grant',
              );
            }
            return refs.member.create(input);
          },
        },
      });
      roleAssignmentGuardRef.handler = createRoleAssignmentGuardMiddleware({
        evaluator: permissions.evaluator,
      });
      pollRequiredGuardRef.handler = buildPollRequiredGuard(app);
      attachmentRequiredGuardRef.handler = buildAttachmentRequiredGuard(app);
    },

    async setupPost({ app, bus, events }: PluginSetupContext) {
      const pluginState = getPluginStateOrNull(app);

      if (!notificationsBuilderFactoryRef) {
        const slingshotCtx = getContext(app);
        notificationsBuilderFactoryRef = resolveCapabilityValue(
          slingshotCtx,
          NotificationsBuilderFactoryCap,
        );
      }
      if (!notificationsBuilderFactoryRef) {
        throw new Error(
          '[slingshot-community] slingshot-notifications is a required dependency. ' +
            'Register createNotificationsPackage() before this package.',
        );
      }
      const builder = notificationsBuilderFactoryRef({ source: 'community' });

      if (!permissionsRef) {
        throw new Error(
          '[slingshot-community] permissions ref missing in setupPost — setupMiddleware did not run',
        );
      }
      const permissions = permissionsRef;

      // ─── Adapter capture assertion ──────────────────────────────────────────
      // The package's entities all use manual wiring and populate `refs`
      // inside `buildAdapter`. If any required adapter is missing at
      // setupPost time, the entity routes never mounted — surface that
      // rather than no-op below.
      if (!refs.thread || !refs.reply || !refs.member || !refs.container) {
        throw new Error(
          '[slingshot-community] required adapters were not captured during entity setup',
        );
      }

      // ─── Adapter-dependent middleware (now adapters are captured) ───────────
      if (!refs.ban || !refs.report) {
        throw new Error(
          '[slingshot-community] ban/report adapters were not captured during entity setup',
        );
      }
      banCheckRef.handler = createBanCheckMiddleware({
        banAdapter: refs.ban,
      });
      autoModRef.handler = createAutoModMiddleware({
        autoModRuleAdapter: refs.autoModRule,
        reportAdapter: refs.report,
      });
      threadStateGuardRef.handler = createThreadStateGuardMiddleware({
        threadAdapter: refs.thread,
      });
      publishedThreadGuardRef.handler = createPublishedThreadGuardMiddleware({
        threadAdapter: refs.thread,
      });
      targetVisibilityGuardRef.handler = createContentTargetGuardMiddleware(
        {
          threadAdapter: refs.thread,
          replyAdapter: refs.reply,
        },
        { requireContainerIdMatch: true },
      );
      reportTargetGuardRef.handler = createContentTargetGuardMiddleware(
        {
          threadAdapter: refs.thread,
          replyAdapter: refs.reply,
        },
        { allowUserTarget: true, attachContainerId: true },
      );
      memberJoinPolicyGuardRef.handler = createMemberJoinPolicyGuardMiddleware({
        containerAdapter: refs.container,
      });
      solutionReplyGuardRef.handler = createSolutionReplyGuardMiddleware({
        replyAdapter: refs.reply,
      });
      replyCountUpdateRef.handler = createReplyCountUpdateMiddleware({
        threadAdapter: refs.thread,
      });
      replyCountDecrementRef.handler = createReplyCountDecrementMiddleware({
        replyAdapter: refs.reply,
        threadAdapter: refs.thread,
      });
      const auditLogAdapter = refs.auditLog;
      auditLogRef.handler = createAuditLogMiddleware({
        adminGate: auditLogAdapter
          ? {
              verifyRequest() {
                return Promise.resolve(null);
              },
              async logAuditEntry(entry) {
                await auditLogAdapter.create({
                  action: entry.action,
                  actorId: entry.actorId,
                  targetId: entry.targetId,
                  targetType: 'community',
                  tenantId: entry.meta?.tenantId as string | undefined,
                  meta: entry.meta,
                });
              },
            }
          : undefined,
      });
      banNotifyRef.handler = createBanNotifyMiddleware({ builder });

      // Republish the plugin state slot now that all adapters are captured.
      // `entityAdapters` is published by the framework's entity-plugin path —
      // read+merge so we don't clobber it.
      if (pluginState) {
        const existing = readPluginState(pluginState, CommunityPluginStateRef);
        publishPluginState(pluginState, CommunityPluginStateRef, {
          ...(existing ?? {}),
          config,
          evaluator: permissions.evaluator,
          interactionsPeer,
        });
      }

      // ─── Event-bus subscribers (mention notify, mention attach, embeds) ─────
      subscribeBusHandlers({
        bus,
        events,
        app,
        refs,
        builder,
      });

      // ─── Push formatter registration (optional integration) ─────────────────
      const maybePushState = resolveCapabilityValue(getContext(app), PushFormatterRegistryCap);
      if (maybePushState) {
        const truncate = (text: unknown, max = 100): string => {
          const str = typeof text === 'string' ? text : '';
          return str.length <= max ? str : `${str.slice(0, max)}…`;
        };

        maybePushState.registerFormatter('community:reply', n => {
          const data = notificationData(n);
          return {
            title: `${toNotificationText(data['actorName'], 'Someone')} replied to your thread`,
            body: truncate(data['threadTitle']),
            url: `/community/threads/${toNotificationText(data['threadId'])}#reply-${toNotificationText(data['replyId'])}`,
          };
        });

        maybePushState.registerFormatter('community:mention', n => {
          const data = notificationData(n);
          const replyId = toNotificationText(data['replyId']);
          return {
            title: `${toNotificationText(data['actorName'], 'Someone')} mentioned you`,
            body: truncate(data['bodyPreview']),
            url: `/community/threads/${toNotificationText(data['threadId'])}${replyId !== '' ? `#reply-${replyId}` : ''}`,
          };
        });

        maybePushState.registerFormatter('community:ban', n => {
          const data = notificationData(n);
          const containerId = toNotificationText(data['containerId']);
          return {
            title:
              containerId !== '' ? 'You have been banned from a container' : 'You have been banned',
            body: toNotificationText(data['reason'], 'Contact a moderator for details.'),
            url: `/community/containers/${containerId}`,
          };
        });

        maybePushState.registerFormatter('community:warning', n => {
          const data = notificationData(n);
          return {
            title: 'Moderator warning',
            body: toNotificationText(data['reason']),
            url: `/community/containers/${toNotificationText(data['containerId'])}`,
          };
        });

        maybePushState.registerFormatter('community:thread.subscribed_reply', n => {
          const data = notificationData(n);
          return {
            title: `New reply in “${toNotificationText(data['threadTitle'], 'a thread')}”`,
            body: truncate(data['bodyPreview']),
            url: `/community/threads/${toNotificationText(data['threadId'])}#reply-${toNotificationText(data['replyId'])}`,
          };
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Bus subscribers extracted into a single helper to keep setupPost readable.
// ---------------------------------------------------------------------------

function subscribeBusHandlers(args: {
  bus: unknown;
  events: PluginSetupContext['events'];
  app: PluginSetupContext['app'];
  refs: CommunityAdapterRefs;
  builder: import('@lastshotlabs/slingshot-core').NotificationBuilder;
}): void {
  const { bus, events, app, refs, builder } = args;
  if (!hasBusOn(bus)) return;

  // Reply-created → thread author notification.
  bus.on('community:reply.created', async payload => {
    const replyPayload = payload as { id?: unknown; replyId?: unknown };
    const replyIdRaw = replyPayload.id ?? replyPayload.replyId;
    const replyId = typeof replyIdRaw === 'string' ? replyIdRaw : undefined;
    const actorId = payload.authorId as string | undefined;
    const threadId = payload.threadId as string | undefined;
    if (!replyId || !actorId || !threadId || !refs.thread) return;

    const thread = await refs.thread.getById(threadId);
    if (!thread?.authorId || !thread.containerId) return;

    await builder.notify({
      tenantId: payload.tenantId as string | undefined,
      userId: thread.authorId,
      type: 'community:reply',
      actorId,
      targetType: 'community:reply',
      targetId: replyId,
      scopeId: thread.containerId,
      dedupKey: `community:reply:${threadId}:${thread.authorId}`,
      data: {
        threadId,
        containerId: thread.containerId,
      },
    });
  });

  function buildMentionDeps(): NotifyMentionsDeps | null {
    if (!refs.thread || !refs.reply) return null;
    return {
      builder,
      threadAdapter: refs.thread,
      replyAdapter: refs.reply,
    };
  }

  bus.on('community:thread.created', async payload => {
    const deps = buildMentionDeps();
    if (!deps) return;
    await notifyMentions(payload, deps, 'thread');
  });

  bus.on('community:reply.created', async payload => {
    const deps = buildMentionDeps();
    if (!deps) return;
    await notifyMentions(payload, deps, 'reply');
  });

  // parseBody → attachMentions: normalise mention sidecars from the body so
  // clients can't spoof `mentions` arrays. Best-effort; silent on failure.
  bus.on('community:thread.created', async payload => {
    if (!refs.thread) return;
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return;
    const record = await refs.thread.getById(id);
    if (!record) return;
    const parsed = parseBody(record.body, record.format ?? 'markdown');
    try {
      await refs.thread.attachMentions(
        { id },
        {
          mentions: parsed.mentions,
          broadcastMentions: parsed.broadcastMentions,
          mentionedRoleIds: parsed.mentionedRoleIds,
        },
      );
    } catch {
      // Silent — best-effort normalization.
    }
  });

  bus.on('community:reply.created', async payload => {
    if (!refs.reply) return;
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    if (!id) return;
    const record = await refs.reply.getById(id);
    if (!record) return;
    const parsed = parseBody(record.body, record.format ?? 'markdown');
    try {
      await refs.reply.attachMentions(
        { id },
        {
          mentions: parsed.mentions,
          broadcastMentions: parsed.broadcastMentions,
          mentionedRoleIds: parsed.mentionedRoleIds,
        },
      );
    } catch {
      // Silent — best-effort normalization.
    }
  });

  // Link unfurl: when slingshot-embeds is registered, fan out
  // thread/reply creates → URL extraction → unfurl → attachEmbeds →
  // `community:thread.embeds.resolved` / `community:reply.embeds.resolved`.
  const embedsState = probeEmbedsPeer(app);
  if (!embedsState) return;

  bus.on('community:thread.created', async payload => {
    if (!refs.thread) return;
    const threadId = typeof payload.id === 'string' ? payload.id : undefined;
    const containerId = typeof payload.containerId === 'string' ? payload.containerId : undefined;
    if (!threadId || !containerId) return;
    const record = await refs.thread.getById(threadId);
    const urls = extractUrls(record?.body);
    if (urls.length === 0) return;
    try {
      const embeds = await embedsState.unfurl(urls);
      if (embeds.length === 0) return;
      await refs.thread.attachEmbeds({ id: threadId }, { embeds });
      events.publish(
        'community:thread.embeds.resolved',
        {
          id: threadId,
          tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : null,
          containerId,
          embeds,
        },
        {
          source: 'system',
          userId: typeof payload.authorId === 'string' ? payload.authorId : null,
          requestTenantId: null,
        },
      );
    } catch {
      // Silent — embed resolution is best-effort.
    }
  });

  bus.on('community:reply.created', async payload => {
    if (!refs.reply) return;
    const replyId = typeof payload.id === 'string' ? payload.id : undefined;
    const containerId = typeof payload.containerId === 'string' ? payload.containerId : undefined;
    if (!replyId || !containerId) return;
    const record = await refs.reply.getById(replyId);
    const threadId = typeof record?.threadId === 'string' ? record.threadId : undefined;
    if (!threadId) return;
    const urls = extractUrls(record?.body);
    if (urls.length === 0) return;
    try {
      const embeds = await embedsState.unfurl(urls);
      if (embeds.length === 0) return;
      await refs.reply.attachEmbeds({ id: replyId }, { embeds });
      events.publish(
        'community:reply.embeds.resolved',
        {
          id: replyId,
          tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : null,
          threadId,
          containerId,
          embeds,
        },
        {
          source: 'system',
          userId: typeof payload.authorId === 'string' ? payload.authorId : null,
          requestTenantId: null,
        },
      );
    } catch {
      // Silent — embed resolution is best-effort.
    }
  });
}
