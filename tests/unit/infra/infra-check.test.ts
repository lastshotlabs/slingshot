import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as realInfra from './realBunshotInfra';

// ---------------------------------------------------------------------------
// CLI integration tests for `slingshot infra check`
//
// These tests exercise the real `InfraCheck` command class, mocking only the
// `@lastshotlabs/slingshot-infra` boundary so we can drive platform/infra config
// and the websocket-scaling audit deterministically. The command surfaces the
// WebSocket scaling diagnostics alongside the existing resource diagnostics,
// and these tests assert that both the "issues present" and "no issues" paths
// render correctly.
// ---------------------------------------------------------------------------

type WsDiagnostic = {
  id: string;
  severity: 'info' | 'warning';
  message: string;
  suggestion: string;
};

type WsAuditResult = { diagnostics: readonly WsDiagnostic[] };

type CompareArgs = {
  infraUses: string[];
  platformResources: string[];
  derivedUses: string[];
};

type CompareResult = {
  warnings: { resource: string; message: string }[];
  infos: { resource: string; message: string }[];
  suggestions: { resource: string; message: string }[];
};

// Mutable handles the individual tests tweak before instantiating the command.
let mockPlatformConfig: { resources?: Record<string, unknown> } = {};
let mockInfraConfig: { uses?: string[] } = {};
let mockDerivedUses: string[] = [];
let mockWsAudit: WsAuditResult = { diagnostics: [] };
let mockCompare: CompareResult = { warnings: [], infos: [], suggestions: [] };

const mockLoadPlatformConfig = mock(async () => ({ config: mockPlatformConfig }));
const mockLoadInfraConfig = mock(async () => ({ config: mockInfraConfig }));
const mockDeriveUsesFromAppConfig = mock(() => mockDerivedUses);
const mockAuditWebsocketScaling = mock(() => mockWsAudit);
const mockCompareInfraResources = mock(() => mockCompare);

mock.module('@lastshotlabs/slingshot-infra', () => ({
  // Spread real implementations so other test files that import from direct source paths
  // are not affected by this mock. Only override functions this test file needs to control.
  ...realInfra,
  loadPlatformConfig: mockLoadPlatformConfig,
  loadInfraConfig: mockLoadInfraConfig,
  deriveUsesFromAppConfig: mockDeriveUsesFromAppConfig,
  auditWebsocketScaling: mockAuditWebsocketScaling,
  compareInfraResources: mockCompareInfraResources,
}));

// Import lazily so the mock.module call above wins over the real package.
// The import is awaited inside a helper to keep top-level sync.
async function loadInfraCheckCommand() {
  const mod = await import('../../../src/cli/commands/infra/check');
  return mod.default;
}

function makeOclifConfig() {
  return {
    runHook: async () => ({ successes: [], failures: [] }),
    scopedEnvVar: () => undefined,
    scopedEnvVarKey: (key: string) => key,
    scopedEnvVarKeys: () => [],
    bin: 'slingshot',
    userAgent: 'slingshot/test',
    theme: undefined,
    findCommand: () => undefined,
  };
}

async function runCheckCommand(): Promise<string> {
  const InfraCheck = await loadInfraCheckCommand();
  const cmd = new InfraCheck([], makeOclifConfig() as never);
  const logs: string[] = [];
  spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  await cmd.run();
  return logs.join('\n');
}

describe('InfraCheck command — websocket scaling output', () => {
  beforeEach(() => {
    mockPlatformConfig = { resources: { postgres: {}, redis: {} } };
    mockInfraConfig = { uses: ['postgres', 'redis'] };
    mockDerivedUses = [];
    mockWsAudit = { diagnostics: [] };
    mockCompare = { warnings: [], infos: [], suggestions: [] };

    mockLoadPlatformConfig.mockClear();
    mockLoadInfraConfig.mockClear();
    mockDeriveUsesFromAppConfig.mockClear();
    mockAuditWebsocketScaling.mockClear();
    mockCompareInfraResources.mockClear();
  });

  it('omits the WebSocket scaling section when the audit reports no diagnostics', async () => {
    mockWsAudit = { diagnostics: [] };

    const output = await runCheckCommand();

    expect(mockAuditWebsocketScaling).toHaveBeenCalled();
    expect(output).not.toContain('WebSocket scaling:');
  });

  it('surfaces a no-transport info diagnostic in the CLI output', async () => {
    mockWsAudit = {
      diagnostics: [
        {
          id: 'ws:no-transport',
          severity: 'info',
          message: 'App defines 1 WebSocket endpoint(s) without a cross-instance transport.',
          suggestion:
            'Configure ws.transport using createRedisTransport() for multi-instance delivery.',
        },
      ],
    };

    const output = await runCheckCommand();

    expect(output).toContain('WebSocket scaling:');
    expect(output).toContain('1 WebSocket endpoint(s) without a cross-instance transport');
    expect(output).toContain('createRedisTransport');
  });

  it('surfaces a presence-without-transport info diagnostic in the CLI output', async () => {
    mockWsAudit = {
      diagnostics: [
        {
          id: 'ws:presence-no-transport',
          severity: 'info',
          message: 'Presence-enabled endpoints without a transport: /ws/chat',
          suggestion:
            'Configure ws.transport so presence join/leave events fan out across instances.',
        },
      ],
    };

    const output = await runCheckCommand();

    expect(output).toContain('WebSocket scaling:');
    expect(output).toContain('/ws/chat');
    expect(output).toContain('presence join/leave events fan out');
  });

  it('surfaces memory-cache warning when multi-instance intent is present', async () => {
    mockWsAudit = {
      diagnostics: [
        {
          id: 'ws:memory-cache-multi-instance',
          severity: 'warning',
          message: 'Cache is set to "memory" while ws.transport indicates a multi-instance setup.',
          suggestion: 'Switch db.cache to "redis" so cached values are shared across instances.',
        },
      ],
    };

    const output = await runCheckCommand();

    expect(output).toContain('WebSocket scaling:');
    expect(output).toContain('Cache is set to "memory"');
    expect(output).toContain('Switch db.cache to "redis"');
  });

  it('renders warning and info icons based on severity', async () => {
    mockWsAudit = {
      diagnostics: [
        {
          id: 'ws:memory-sessions-multi-instance',
          severity: 'warning',
          message:
            'Sessions are set to "memory" while ws.transport indicates a multi-instance setup.',
          suggestion: 'Switch db.sessions to "redis" for shared session state.',
        },
        {
          id: 'ws:no-transport',
          severity: 'info',
          message: 'App defines 2 WebSocket endpoint(s) without a cross-instance transport.',
          suggestion: 'Configure ws.transport using createRedisTransport().',
        },
      ],
    };

    const output = await runCheckCommand();

    // Warning uses the warning sign (U+26A0), info uses the info sign (U+2139).
    expect(output).toContain('\u26A0 Sessions are set to "memory"');
    expect(output).toContain('\u2139 App defines 2 WebSocket endpoint(s)');
    // Each diagnostic emits a suggestion line prefixed with the arrow (U+2192).
    expect(output).toContain('\u2192 Switch db.sessions to "redis"');
    expect(output).toContain('\u2192 Configure ws.transport using createRedisTransport().');
  });

  it('renders WebSocket diagnostics in addition to existing resource diagnostics', async () => {
    mockCompare = {
      warnings: [
        { resource: 'kafka', message: "'kafka' is declared in uses but not defined in platform" },
      ],
      infos: [],
      suggestions: [],
    };
    mockWsAudit = {
      diagnostics: [
        {
          id: 'ws:no-transport',
          severity: 'info',
          message: 'App defines 1 WebSocket endpoint(s) without a cross-instance transport.',
          suggestion: 'Configure ws.transport using createRedisTransport().',
        },
      ],
    };

    const output = await runCheckCommand();

    // Resource warning is rendered above the websocket section.
    expect(output).toContain("'kafka' is declared in uses but not defined in platform");
    expect(output).toContain('WebSocket scaling:');
    expect(output).toContain('1 WebSocket endpoint(s) without a cross-instance transport');
    expect(output.indexOf('kafka')).toBeLessThan(output.indexOf('WebSocket scaling:'));
  });
});
