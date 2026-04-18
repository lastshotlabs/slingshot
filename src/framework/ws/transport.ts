/**
 * Pluggable transport for cross-instance WebSocket message delivery.
 *
 * `publish()` is called on every room broadcast — the transport fans out
 * the message to other server instances (e.g. via Redis pub/sub).
 *
 * `connect()` is called once at server startup. The `onMessage` callback
 * should be invoked when a message arrives from another instance —
 * it will be delivered to local sockets via Bun's native `server.publish()`.
 *
 * `disconnect()` is called on graceful shutdown.
 */
export interface WsTransportAdapter {
  /**
   * Fan out a message to other instances.
   * Called on every `publish()` in ws.ts — must be non-blocking.
   * Errors are caught and logged by the caller; they never break local delivery.
   * @param origin — unique ID of the publishing instance (for self-echo filtering)
   */
  publish(endpoint: string, room: string, message: string, origin: string): Promise<void>;

  /**
   * Connect to the transport backend.
   * @param onMessage — call this when a message arrives from the transport.
   *   Includes `origin` so the caller can skip self-echo.
   */
  connect(
    onMessage: (endpoint: string, room: string, message: string, origin: string) => void,
  ): Promise<void>;

  /** Disconnect from the transport backend. Called on SIGTERM/SIGINT. */
  disconnect(): Promise<void>;
}

/**
 * Default no-op transport. Single-instance — all messages go through
 * Bun's native `server.publish()` only. No cross-instance delivery.
 */
export class InMemoryTransport implements WsTransportAdapter {
  publish(endpoint: string, room: string, message: string, origin: string): Promise<void> {
    void endpoint;
    void room;
    void message;
    void origin;
    return Promise.resolve();
  }
  connect(
    onMessage: (endpoint: string, room: string, message: string, origin: string) => void,
  ): Promise<void> {
    void onMessage;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}
