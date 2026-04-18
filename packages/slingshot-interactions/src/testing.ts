import type { Dispatcher } from './handlers/contracts';
import type { DispatchResult } from './routes/dispatchRoute.schema';

/** Build a default button fixture for component tests. */
export function buildTestButton(overrides: Record<string, unknown> = {}) {
  return {
    type: 'button',
    actionId: 'test:click',
    label: 'Click me',
    ...overrides,
  };
}

/** Build a default action-row fixture for component tests. */
export function buildTestActionRow(overrides: Record<string, unknown> = {}) {
  return {
    type: 'actionRow',
    children: [buildTestButton()],
    ...overrides,
  };
}

/** Build a default interaction-event fixture for audit tests. */
export function buildTestInteractionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_test',
    tenantId: '',
    userId: 'user_test',
    messageKind: 'chat:message',
    messageId: 'msg_test',
    actionId: 'test:click',
    actionIdPrefix: 'test',
    handlerKind: 'queue',
    responseStatus: 'ok',
    latencyMs: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a fake dispatcher from a provided implementation function. */
export function createFakeDispatcher(
  impl: (payload: Parameters<Dispatcher['dispatch']>[0]) => Promise<DispatchResult>,
): Dispatcher {
  return {
    dispatch(payload) {
      return impl(payload);
    },
  };
}
