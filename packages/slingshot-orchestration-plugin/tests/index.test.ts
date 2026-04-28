import { describe, expect, test } from 'bun:test';
import * as orchestrationPlugin from '../src/index';

describe('orchestration plugin public entrypoint', () => {
  test('exports the runtime integration surface', () => {
    expect(typeof orchestrationPlugin.createOrchestrationPlugin).toBe('function');
    expect(typeof orchestrationPlugin.getOrchestration).toBe('function');
    expect(typeof orchestrationPlugin.getOrchestrationOrNull).toBe('function');
    expect(typeof orchestrationPlugin.createSlingshotEventSink).toBe('function');
    expect(orchestrationPlugin.orchestrationPluginConfigSchema).toBeDefined();
    expect(orchestrationPlugin.ORCHESTRATION_PLUGIN_KEY).toBe('slingshot-orchestration');
  });
});
