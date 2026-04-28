# Bun upstream bugs (to file at `oven-sh/bun`)

Two bugs surfaced while hardening the Slingshot Bun runtime
(`../src/index.ts`). Both reproduce on Bun 1.3.11 (macOS arm64). Captured here
so we can file upstream issues with minimal repros.

---

## Bug 1: `server.stop()` hangs with active WebSocket connections

- **Bun version**: 1.3.11
- **Platform**: macOS arm64 (also seen on Linux x64 in CI)
- **Symptom**: A bare `Bun.serve` with WS upgrade, given an open client
  connection, will hang indefinitely if you `await server.stop()` _or_
  `await server.stop(true)`. The promise never resolves even after the
  client-side `ws.close()` has fully completed.
- **Expected**: `server.stop()` resolves once in-flight requests/sockets have
  drained. `server.stop(true)` (force) terminates active connections and
  resolves promptly.
- **Workaround**: explicitly drain by calling `ws.close(code, reason)` for
  every active socket, awaiting a per-socket promise that resolves from the
  server's `close` handler, _then_ calling `server.stop()`. See the
  `activeWebSockets` set + `waitForWebSocketDrain` logic in
  [`../src/index.ts`](../src/index.ts).

### Minimal repro

```ts
const server = Bun.serve({
  port: 0,
  fetch(req, s) {
    return s.upgrade(req) ? undefined : new Response('no');
  },
  websocket: { open() {}, message() {}, close() {} },
});
const ws = new WebSocket(`ws://localhost:${server.port}`);
await new Promise(r => (ws.onopen = r));
ws.close();
await new Promise(r => (ws.onclose = r));
await server.stop(true); // hangs forever
```

---

## Bug 2: WebSocket close code 1001 collapses to 1006 under `bun test`

- **Bun version**: 1.3.11
- **Platform**: macOS arm64
- **Symptom**: Server-side `ws.close(1001, 'reason')` immediately followed by
  `server.stop()` delivers a 1001 close frame with the supplied reason when
  run under `bun run`, but under `bun test` the client frequently observes
  `1006` (abnormal closure) with an empty reason instead. The runtime's own
  `close` handler still fires with 1001 + reason on the server side; only the
  wire frame is mis-delivered to the client.
- **Expected**: client receives `code === 1001` and the reason string, on both
  `bun run` and `bun test`, regardless of how soon `server.stop()` is called.
- **Workaround**: per socket, await a promise that resolves from inside the
  `close` handler before invoking `server.stop()`. See drain logic in
  [`../src/index.ts`](../src/index.ts) and the test-side handling in
  [`../tests/ws-pubsub.test.ts`](../tests/ws-pubsub.test.ts) (the test now
  accepts either 1001 or 1006 because of this bug).

### Minimal repro

```ts
const server = Bun.serve({
  port: 0,
  fetch(req, s) {
    return s.upgrade(req) ? undefined : new Response('no');
  },
  websocket: {
    open(ws) {
      ws.close(1001, 'going away');
    },
    message() {},
    close() {},
  },
});
const ws = new WebSocket(`ws://localhost:${server.port}`);
const ev = await new Promise<CloseEvent>(r => (ws.onclose = r));
console.log(ev.code, ev.reason); // bun run: 1001 'going away' | bun test: 1006 ''
await server.stop(true);
```

Run with `bun test repro.test.ts` (wrap in `it(...)`) to see the 1006 result.
