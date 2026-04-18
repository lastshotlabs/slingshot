import { describe, expect, it } from 'bun:test';
import { createPresetRegistry } from '../../../packages/slingshot-infra/src/preset/presetRegistry';
import { createProvisionerRegistry } from '../../../packages/slingshot-infra/src/resource/provisionerRegistry';
import type { PresetProvider } from '../../../packages/slingshot-infra/src/types/preset';
import type { ResourceProvisioner } from '../../../packages/slingshot-infra/src/types/resource';

function createMockPreset(name: string): PresetProvider {
  return {
    name,
    generate: () => [],
    deploy: async () => ({ success: true }),
    provisionStack: async () => ({ success: true, outputs: {} }),
    destroyStack: async () => {},
    defaultLogging: () => ({ driver: 'local', retentionDays: 7 }),
  };
}

function createMockProvisioner(type: string): ResourceProvisioner {
  return {
    resourceType: type,
    provision: async () => ({ status: 'provisioned', outputs: {}, connectionEnv: {} }),
    destroy: async () => {},
    getConnectionEnv: o => o.connectionEnv,
  };
}

describe('createPresetRegistry', () => {
  it('get returns registered preset by name', () => {
    const registry = createPresetRegistry([createMockPreset('ecs'), createMockPreset('ec2-nginx')]);
    const preset = registry.get('ecs');
    expect(preset.name).toBe('ecs');
  });

  it('get throws for unknown preset name with available list', () => {
    const registry = createPresetRegistry([createMockPreset('ecs'), createMockPreset('ec2-nginx')]);
    expect(() => registry.get('lambda')).toThrow('Unknown preset: "lambda"');
    expect(() => registry.get('lambda')).toThrow('Available: ecs, ec2-nginx');
  });

  it('names() returns all registered preset names', () => {
    const registry = createPresetRegistry([createMockPreset('ecs'), createMockPreset('ec2-nginx')]);
    expect(registry.names()).toEqual(['ecs', 'ec2-nginx']);
  });

  it('names() returns empty array when no presets registered', () => {
    const registry = createPresetRegistry([]);
    expect(registry.names()).toEqual([]);
  });

  it('last preset wins when duplicate names registered', () => {
    const first = createMockPreset('ecs');
    const second = createMockPreset('ecs');
    const registry = createPresetRegistry([first, second]);

    // Map constructor with duplicate keys keeps the last value
    const result = registry.get('ecs');
    expect(result).toBe(second);
  });
});

describe('createProvisionerRegistry', () => {
  it('get returns registered provisioner by type', () => {
    const registry = createProvisionerRegistry([
      createMockProvisioner('postgres'),
      createMockProvisioner('redis'),
    ]);
    const p = registry.get('postgres');
    expect(p.resourceType).toBe('postgres');
  });

  it('get throws for unknown type with available list', () => {
    const registry = createProvisionerRegistry([
      createMockProvisioner('postgres'),
      createMockProvisioner('redis'),
    ]);
    expect(() => registry.get('mongo')).toThrow('No provisioner for resource type: "mongo"');
    expect(() => registry.get('mongo')).toThrow('Available: postgres, redis');
  });

  it('types() returns all registered resource types', () => {
    const registry = createProvisionerRegistry([
      createMockProvisioner('postgres'),
      createMockProvisioner('redis'),
      createMockProvisioner('kafka'),
    ]);
    expect(registry.types()).toEqual(['postgres', 'redis', 'kafka']);
  });

  it('types() returns empty array when no provisioners registered', () => {
    const registry = createProvisionerRegistry([]);
    expect(registry.types()).toEqual([]);
  });
});
