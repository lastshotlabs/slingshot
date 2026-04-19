import type { PermissionEvaluator, RateLimitAdapter } from '@lastshotlabs/slingshot-core';
import { componentTreeSchema, modalSchema } from '../components/schema';
import type { MessageKind } from '../components/types';
import type { InteractionResponseStatus } from '../entities/interactionEvent';
import type {
  ChatInteractionsPeer,
  CommunityInteractionsPeer,
  InteractionsPeer,
} from '../peers/types';
import type { DispatchRequest, DispatchResult } from '../routes/dispatchRoute.schema';
import type { CompiledHandlerTable } from './contracts';

/** Runtime dependencies required by the interaction orchestrator. */
export interface DispatchDeps {
  readonly handlers: CompiledHandlerTable;
  readonly evaluator: PermissionEvaluator;
  readonly rateLimit: RateLimitAdapter;
  readonly peers: {
    readonly chat: ChatInteractionsPeer | null;
    readonly community: CommunityInteractionsPeer | null;
  };
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
}

/** Structured dispatch outcome returned to the route layer and audit writer. */
export interface DispatchOutcome {
  readonly httpStatus: number;
  readonly status: InteractionResponseStatus;
  readonly body: unknown;
  readonly latencyMs: number;
  readonly handlerKind: 'webhook' | 'route' | 'queue' | 'none';
  readonly errorDetail?: string;
}

function deriveActionIdPrefix(actionId: string): string {
  const separatorIndex = actionId.indexOf(':');
  return separatorIndex === -1 ? actionId : actionId.slice(0, separatorIndex);
}

function selectPeer(kind: MessageKind, peers: DispatchDeps['peers']): InteractionsPeer | null {
  if (kind === 'chat:message') return peers.chat;
  return peers.community;
}

function findComponentByActionId(
  tree: ReadonlyArray<{ children: ReadonlyArray<{ actionId?: string; permission?: string }> }>,
  actionId: string,
): { actionId?: string; permission?: string } | null {
  for (const row of tree) {
    for (const child of row.children) {
      if (child.actionId === actionId) return child;
    }
  }

  return null;
}

/**
 * Dispatch a user interaction against the owning message peer.
 *
 * @param deps - Resolved runtime dependencies.
 * @param request - Dispatch request payload.
 * @param authUserId - Authenticated user ID performing the interaction.
 * @param tenantId - Current tenant ID.
 * @returns Structured outcome with HTTP status, semantic status, and response body.
 */
export async function dispatchInteraction(
  deps: DispatchDeps,
  request: DispatchRequest,
  authUserId: string,
  tenantId: string,
): Promise<DispatchOutcome> {
  const startedAt = Date.now();
  const peer = selectPeer(request.messageKind, deps.peers);

  if (peer === null) {
    return {
      httpStatus: 503,
      status: 'error',
      body: { error: 'handler peer not installed', messageKind: request.messageKind },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
      errorDetail: `peer missing: ${request.messageKind}`,
    };
  }

  const message = await peer.resolveMessageByKindAndId(request.messageKind, request.messageId);
  if (message === null) {
    return {
      httpStatus: 404,
      status: 'notFound',
      body: { error: 'message not found' },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
    };
  }

  const parsedTree = componentTreeSchema.safeParse(
    (message as { components?: unknown }).components ?? [],
  );
  if (!parsedTree.success) {
    return {
      httpStatus: 404,
      status: 'notFound',
      body: { error: 'stale or invalid components' },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
      errorDetail: 'components tree failed schema parse',
    };
  }

  const component = findComponentByActionId(parsedTree.data, request.actionId);
  if (component === null) {
    return {
      httpStatus: 404,
      status: 'notFound',
      body: { error: 'component not found on message' },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
    };
  }

  if (component.permission) {
    const allowed = await deps.evaluator.can(
      { subjectId: authUserId, subjectType: 'user' },
      component.permission,
      {
        tenantId,
        resourceType: request.messageKind,
        resourceId: request.messageId,
      },
    );
    if (!allowed) {
      return {
        httpStatus: 403,
        status: 'forbidden',
        body: { error: 'permission denied', permission: component.permission },
        latencyMs: Date.now() - startedAt,
        handlerKind: 'none',
      };
    }
  }

  const exceeded = await deps.rateLimit.trackAttempt(
    `interactions:${authUserId}:${deriveActionIdPrefix(request.actionId)}`,
    {
      windowMs: deps.rateLimitWindowMs,
      max: deps.rateLimitMax,
    },
  );
  if (exceeded) {
    return {
      httpStatus: 429,
      status: 'rateLimited',
      body: { error: 'rate limited', retryAfterMs: deps.rateLimitWindowMs },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
    };
  }

  const resolved = deps.handlers.resolve(request.actionId);
  if (resolved === null) {
    return {
      httpStatus: 404,
      status: 'notFound',
      body: { error: 'no handler registered for this actionId prefix' },
      latencyMs: Date.now() - startedAt,
      handlerKind: 'none',
    };
  }

  let result: DispatchResult;
  try {
    result = await resolved.dispatcher.dispatch({
      actionId: request.actionId,
      messageKind: request.messageKind,
      messageId: request.messageId,
      userId: authUserId,
      tenantId,
      values: request.values,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown dispatcher error';
    const isTimeout = detail.toLowerCase().includes('timeout');

    return {
      httpStatus: isTimeout ? 504 : 502,
      status: isTimeout ? 'timeout' : 'error',
      body: { error: detail },
      latencyMs: Date.now() - startedAt,
      handlerKind: resolved.template.kind,
      errorDetail: detail,
    };
  }

  if (result.messageUpdate) {
    const nextComponents = componentTreeSchema.safeParse(result.messageUpdate.components);
    if (!nextComponents.success) {
      return {
        httpStatus: 502,
        status: 'error',
        body: { error: 'dispatcher returned invalid components tree' },
        latencyMs: Date.now() - startedAt,
        handlerKind: resolved.template.kind,
        errorDetail: 'messageUpdate.components failed schema parse',
      };
    }

    await peer.updateComponents(request.messageKind, request.messageId, nextComponents.data);
  }

  if (result.modal) {
    const parsedModal = modalSchema.safeParse(result.modal);
    if (!parsedModal.success) {
      return {
        httpStatus: 502,
        status: 'error',
        body: { error: 'dispatcher returned invalid modal' },
        latencyMs: Date.now() - startedAt,
        handlerKind: resolved.template.kind,
        errorDetail: 'modal failed schema parse',
      };
    }
  }

  return {
    httpStatus: result.status === 'ok' ? 200 : 502,
    status: result.status === 'ok' ? 'ok' : 'error',
    body: result.body ?? { status: result.status, message: result.message },
    latencyMs: Date.now() - startedAt,
    handlerKind: resolved.template.kind,
  };
}
