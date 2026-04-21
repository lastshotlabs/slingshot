/**
 * GamePlayer entity definition.
 *
 * Defines the persisted player entity with all fields, indexes,
 * route configuration, permissions, and event declarations.
 *
 * See spec §2.4.1, §6.1, and §26.3 for the full contract.
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { GAME_SESSION_POLICY_KEY } from '../policy';

/**
 * GamePlayer entity definition.
 *
 * Persisted player record linking a user to a session with role,
 * team, score, connection status, and join order. Unique on
 * `(sessionId, userId)`.
 */
export const GamePlayer = defineEntity('GamePlayer', {
  namespace: 'game',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    sessionId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    displayName: field.string(),
    role: field.string({ optional: true }),
    team: field.string({ optional: true }),
    playerState: field.string({ optional: true }),
    score: field.number({ default: 0 }),
    connected: field.boolean({ default: true }),
    isHost: field.boolean({ default: false }),
    isSpectator: field.boolean({ default: false }),
    joinOrder: field.number({ default: 0 }),
    disconnectCount: field.number({ default: 0 }),
    disconnectedAt: field.date({ optional: true }),
    joinedAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['sessionId']),
    index(['sessionId', 'userId'], { unique: true }),
    index(['userId']),
  ],
  routes: {
    defaults: {
      auth: 'userAuth',
      permission: {
        requires: 'game:read',
        policy: { resolver: GAME_SESSION_POLICY_KEY },
      },
    },
    get: {},
    list: {},
    create: {
      middleware: ['playerJoinGuard'],
      event: {
        key: 'game:player.joined',
        payload: ['sessionId', 'userId'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:userId',
          resourceType: 'game-session',
          resourceId: 'record:sessionId',
        },
      },
    },
    delete: {
      middleware: ['playerLeaveGuard'],
      event: {
        key: 'game:player.left',
        payload: ['sessionId', 'userId'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:userId',
          resourceType: 'game-session',
          resourceId: 'record:sessionId',
        },
      },
    },
    operations: {
      findBySession: {},
      findBySessionAndUser: {},
      incrementScore: {},
      updateConnection: {},
      countBySession: {},
      assignTeam: {
        middleware: ['hostOnlyGuard', 'lobbyOnlyGuard'],
      },
      assignRole: {
        middleware: ['hostOnlyGuard', 'lobbyOnlyGuard'],
      },
      kick: {
        middleware: ['hostOnlyGuard'],
      },
    },
    permissions: {
      resourceType: 'game-player',
      actions: ['read', 'join', 'leave', 'kick'],
    },
  },
});
