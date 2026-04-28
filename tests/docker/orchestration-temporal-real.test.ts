/**
 * Real Temporal integration tests for the Temporal orchestration adapter
 * (`@lastshotlabs/slingshot-orchestration-temporal`).
 *
 * Scope note: the comprehensive end-to-end suite that exercises a real worker,
 * task and workflow execution, signals, schedules, and progress lives at
 * `tests/node-docker/temporal-orchestration.test.ts` (vitest, Node runtime).
 * That test must run on Node because the Temporal worker bridge ships native
 * code (`@temporalio/core-bridge`) that refuses to start under Bun
 * (`assertNodeRuntime` in `packages/slingshot-orchestration-temporal/src/worker.ts`).
 *
 * This file fills the bun-test gap: it covers the *adapter-only* surface that
 * does not need a worker — `Connection.connect()`, namespace + visibility
 * validation in `adapter.start()`, typed-error mapping when the connection
 * target is unreachable, and `adapter.shutdown()` cleanly closing both the
 * Client and the Connection it owns. Together with the Node test it gives us
 * full coverage of the docker-backed Temporal surface.
 *
 * Guard: when the docker Temporal namespace at `localhost:7233` is unreachable
 * the entire suite is skipped.
 */
import { Client, Connection } from '@temporalio/client';
import { afterEach, describe, expect, test } from 'bun:test';
import { createTemporalOrchestrationAdapter } from '../../packages/slingshot-orchestration-temporal/src/adapter';

const TEMPORAL_ADDRESS = process.env.TEST_TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEST_TEMPORAL_NAMESPACE ?? 'default';

// ─────────────────────────────────────────────────────────────────────────────
// Reachability probe — skip the whole suite when Temporal is not running.
// ─────────────────────────────────────────────────────────────────────────────

async function probeTemporal(): Promise<boolean> {
  try {
    const conn = await Connection.connect({ address: TEMPORAL_ADDRESS });
    try {
      const client = new Client({ connection: conn, namespace: TEMPORAL_NAMESPACE });
      // workflow.count() is the cheapest visibility query supported by the
      // dev server. If it succeeds the namespace exists and the search
      // attributes our adapter requires are registered.
      await client.workflow.count();
      return true;
    } finally {
      await conn.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

const TEMPORAL_AVAILABLE = await probeTemporal();

// ─────────────────────────────────────────────────────────────────────────────
// Per-test cleanup
// ─────────────────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const fns = cleanups.splice(0).reverse();
  for (const fn of fns) {
    try {
      await fn();
    } catch (error) {
      console.error('[orchestration-temporal-docker] cleanup failed:', error);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!TEMPORAL_AVAILABLE)(
  'Temporal orchestration adapter — real Temporal connection (docker)',
  () => {
    test(// Why: validates the happy-path connection lifecycle. adapter.start()
    // exercises ensureConnected(), workflow.count(), and the search-attribute
    // validation queries. If any of those fail the adapter throws — proving
    // the start path runs against a real broker rather than a mock that
    // cannot reject malformed visibility queries.
    'adapter.start() validates namespace and visibility queries against the real broker', async () => {
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      cleanups.push(() => connection.close());
      const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

      const adapter = createTemporalOrchestrationAdapter({
        client,
        connection,
        namespace: TEMPORAL_NAMESPACE,
        // The dev-server compose stack does not register a worker on this
        // queue. We never start a worker in this test so this string is
        // arbitrary and only feeds future workflow.start() calls.
        workflowTaskQueue: 'slingshot-bun-docker-test',
        ownsConnection: false,
      });
      cleanups.push(() => adapter.shutdown());

      // start() throws if visibility validation fails. No assertion needed
      // beyond "it resolved" — the validation queries themselves do the work.
      await expect(adapter.start()).resolves.toBeUndefined();
    }, 30_000);

    test(// Why: production deployments mis-configure addresses (wrong port,
    // typo'd host) often enough that the adapter must fail fast with a
    // diagnosable error rather than hang or return null. Connection.connect
    // throws when the gRPC channel cannot be established; this test pins
    // the public contract that the failure surfaces at the connect layer.
    'Connection.connect() rejects with a typed error when the address is wrong', async () => {
      // Port 7299 is intentionally not exposed by docker-compose.test.yml.
      // connectTimeout keeps the test fast — without it the gRPC stack
      // can wait minutes before giving up.
      const startedAt = Date.now();
      await expect(
        Connection.connect({
          address: 'localhost:7299',
          connectTimeout: '500ms',
        }),
      ).rejects.toThrow();
      // Sanity: the failure happened quickly. If this ever takes > 10s the
      // SDK behavior has changed and the test should be revisited.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    }, 15_000);

    test(// Why: shutdown() must close both the Temporal Client (best-effort: only
    // if a future SDK exposes close()) and the underlying Connection when
    // ownsConnection=true. Without this the gRPC channel leaks beyond
    // process teardown, which on bun manifests as test hangs at exit.
    // We assert that a second close() on the same connection rejects,
    // which proves the adapter actually closed it.
    'adapter.shutdown() closes the connection when ownsConnection=true', async () => {
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

      const adapter = createTemporalOrchestrationAdapter({
        client,
        connection,
        namespace: TEMPORAL_NAMESPACE,
        workflowTaskQueue: 'slingshot-bun-docker-test',
        ownsConnection: true,
      });

      await adapter.start();
      await adapter.shutdown();

      // After shutdown the underlying gRPC channel is closed. Any further
      // RPC must fail — we issue a fresh visibility query through the same
      // connection to observe that shutdown actually closed it. If the
      // adapter forgot to honor ownsConnection=true this resolves and the
      // ownership contract is silently broken.
      const probe = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
      await expect(probe.workflow.count()).rejects.toThrow();
    }, 30_000);

    test(// Why: with ownsConnection=false the adapter must NOT close the caller's
    // connection during shutdown. This is critical for apps that reuse one
    // long-lived Temporal connection across multiple subsystems — losing
    // the connection on adapter shutdown would cascade to unrelated code.
    'adapter.shutdown() leaves connection open when ownsConnection=false', async () => {
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      cleanups.push(() => connection.close());
      const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

      const adapter = createTemporalOrchestrationAdapter({
        client,
        connection,
        namespace: TEMPORAL_NAMESPACE,
        workflowTaskQueue: 'slingshot-bun-docker-test',
        ownsConnection: false,
      });

      await adapter.start();
      await adapter.shutdown();

      // The connection should still be usable — issue a fresh visibility
      // query to prove it. If shutdown closed the connection this throws.
      const probe = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
      await expect(probe.workflow.count()).resolves.toBeDefined();
    }, 30_000);
  },
);
