/**
 * Test helper for invoking the optional `shutdown()` method on an event bus.
 *
 * `SlingshotEventBus.shutdown` is optional in the core contract, but every
 * adapter under test implements it. Narrowing once here keeps call sites clean
 * without sprinkling non-null assertions through the tests, and fails loudly if
 * an adapter ever stops providing `shutdown()`.
 */
export function shutdownBus(bus: { shutdown?: () => Promise<void> }): Promise<void> {
  const shutdown = bus.shutdown;
  if (!shutdown) throw new Error('bus.shutdown is not implemented on this adapter');
  return shutdown.call(bus);
}
