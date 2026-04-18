/**
 * GameSession entity definition.
 *
 * Defines the persisted session entity with all fields, indexes,
 * route configuration, permissions, and event declarations.
 *
 * See spec §2.4.1, §5.1, and §26.2 for the full contract.
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { GAME_SESSION_POLICY_KEY } from '../policy';

/**
 * GameSession entity definition.
 *
 * Persisted session record with status, phase, round, RNG state,
 * win result, and all timing fields. Indexed by game type, status,
 * join code, host, and parent session.
 */
export const GameSession = defineEntity('GameSession', {
  namespace: 'game',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    gameType: field.string({ immutable: true }),
    hostUserId: field.string({ immutable: true }),
    tenantId: field.string({ optional: true, immutable: true }),
    status: field.string({ default: 'lobby' }),
    joinCode: field.string({ optional: true }),
    rules: field.json({ optional: true }),
    gameState: field.json({ optional: true }),
    privateState: field.json({ optional: true }),
    currentPhase: field.string({ optional: true }),
    currentSubPhase: field.string({ optional: true }),
    currentRound: field.number({ default: 0 }),
    rngSeed: field.number({ optional: true }),
    rngState: field.number({ optional: true }),
    parentSessionId: field.string({ optional: true }),
    winResult: field.json({ optional: true }),
    contentConfig: field.json({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now' }),
    startedAt: field.date({ optional: true }),
    completedAt: field.date({ optional: true }),
    lastActivityAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['gameType']),
    index(['status']),
    index(['joinCode']),
    index(['hostUserId']),
    index(['parentSessionId']),
    index(['tenantId', 'status']),
  ],
  routes: {
    dataScope: {
      field: 'tenantId',
      from: 'ctx:tenantId',
      applyTo: ['create', 'list'],
    },
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
      permission: { requires: 'game:create' },
      middleware: ['sessionCreateGuard'],
      event: {
        key: 'game:session.created',
        payload: ['id', 'gameType', 'hostUserId', 'tenantId'],
      },
    },
    delete: {
      permission: {
        requires: 'game:admin',
        policy: { resolver: GAME_SESSION_POLICY_KEY },
      },
    },
    operations: {
      findByJoinCode: {},
      findByGameType: {},
      startGame: {
        middleware: ['hostOnlyGuard', 'startGameGuard'],
        event: {
          key: 'game:session.started',
          payload: ['id', 'gameType'],
        },
      },
      pauseGame: {
        middleware: ['hostOnlyGuard'],
      },
      resumeGame: {
        middleware: ['hostOnlyGuard'],
      },
      completeGame: {},
      abandonSession: {},
      updateRules: {
        middleware: ['hostOnlyGuard', 'lobbyOnlyGuard', 'rulesValidationGuard'],
      },
      updateContent: {
        middleware: ['hostOnlyGuard', 'lobbyOnlyGuard', 'contentValidationGuard'],
      },
      endGame: {
        middleware: ['hostOnlyGuard'],
        event: {
          key: 'game:session.completed',
          payload: ['id', 'gameType'],
        },
      },
    },
    clientSafeEvents: [
      'game:session.created',
      'game:session.started',
      'game:session.completed',
      'game:session.abandoned',
    ],
    permissions: {
      resourceType: 'game-session',
      actions: ['read', 'create', 'join', 'admin'],
    },
  },
});
