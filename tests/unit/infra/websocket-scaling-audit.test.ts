import { describe, expect, it } from 'bun:test';
import { auditWebsocketScaling } from '../../../packages/slingshot-infra/src/config/websocketScalingAudit';

describe('auditWebsocketScaling', () => {
  it('returns no diagnostics when no ws config is present', () => {
    const result = auditWebsocketScaling({});
    expect(result.diagnostics).toHaveLength(0);
  });

  it('returns no diagnostics when ws has no endpoints', () => {
    const result = auditWebsocketScaling({ ws: { endpoints: {} } });
    expect(result.diagnostics).toHaveLength(0);
  });

  it('reports info when endpoints exist but no transport is configured', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
      },
    });

    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.id).toBe('ws:no-transport');
    expect(d.severity).toBe('info');
    expect(d.message).toContain('1 WebSocket endpoint(s)');
    expect(d.message).toContain('without a cross-instance transport');
    expect(d.suggestion).toContain('createRedisTransport');
  });

  it('reports info for presence-enabled endpoints without transport', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: {
          '/ws/chat': { presence: true },
          '/ws/data': {},
        },
      },
    });

    expect(result.diagnostics).toHaveLength(2);

    const noTransport = result.diagnostics.find(d => d.id === 'ws:no-transport');
    expect(noTransport).toBeDefined();
    expect(noTransport!.message).toContain('2 WebSocket endpoint(s)');

    const presenceWarn = result.diagnostics.find(d => d.id === 'ws:presence-no-transport');
    expect(presenceWarn).toBeDefined();
    expect(presenceWarn!.severity).toBe('info');
    expect(presenceWarn!.message).toContain('/ws/chat');
    expect(presenceWarn!.message).not.toContain('/ws/data');
  });

  it('does not report presence warning when presence is false', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: {
          '/ws': { presence: false },
        },
      },
    });

    // Only the no-transport warning, no presence warning
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].id).toBe('ws:no-transport');
  });

  it('reports warning for memory cache with transport configured', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
        transport: { publish: () => {} },
      },
      db: { cache: 'memory' },
    });

    const cacheWarn = result.diagnostics.find(d => d.id === 'ws:memory-cache-multi-instance');
    expect(cacheWarn).toBeDefined();
    expect(cacheWarn!.severity).toBe('warning');
    expect(cacheWarn!.message).toContain('Cache is set to "memory"');
    expect(cacheWarn!.suggestion).toContain('redis');
  });

  it('reports warning for memory sessions with transport configured', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
        transport: { publish: () => {} },
      },
      db: { sessions: 'memory' },
    });

    const sessionWarn = result.diagnostics.find(d => d.id === 'ws:memory-sessions-multi-instance');
    expect(sessionWarn).toBeDefined();
    expect(sessionWarn!.severity).toBe('warning');
    expect(sessionWarn!.message).toContain('Sessions are set to "memory"');
  });

  it('does not report memory warnings without transport', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
      },
      db: { cache: 'memory', sessions: 'memory' },
    });

    // Should only have the no-transport info, not the memory warnings
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].id).toBe('ws:no-transport');
  });

  it('does not report memory warnings when cache/sessions are not memory', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
        transport: { publish: () => {} },
      },
      db: { cache: 'redis', sessions: 'redis' },
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  it('returns frozen result', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { '/ws': {} } },
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    // Deep freeze: each diagnostic entry must also be immutable so consumers
    // cannot mutate warning/info metadata after it crosses the package boundary.
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
  });

  it('reports both memory cache and sessions warnings together', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: { '/ws': {} },
        transport: { publish: () => {} },
      },
      db: { cache: 'memory', sessions: 'memory' },
    });

    const ids = result.diagnostics.map(d => d.id);
    expect(ids).toContain('ws:memory-cache-multi-instance');
    expect(ids).toContain('ws:memory-sessions-multi-instance');
  });

  it('handles presence as an object config', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: {
          '/ws': { presence: { broadcastEvents: true } },
        },
      },
    });

    const presenceWarn = result.diagnostics.find(d => d.id === 'ws:presence-no-transport');
    expect(presenceWarn).toBeDefined();
  });
});
