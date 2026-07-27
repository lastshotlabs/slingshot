import { describe, expect, test } from 'bun:test';
import {
  ENTITY_BACKEND_CAPABILITIES,
  ENTITY_OPERATION_KINDS,
  type StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  ENTITY_BACKEND_PROFILES,
  getEntityBackendProfile,
} from '../../src/configDriven/backendProfiles';

const STORES = [
  'memory',
  'sqlite',
  'postgres',
  'mongo',
  'redis',
] as const satisfies readonly StoreType[];

describe('entity backend profiles', () => {
  test('are exhaustive, unique, and deeply frozen', () => {
    expect(new Set(ENTITY_OPERATION_KINDS).size).toBe(19);
    expect(new Set(ENTITY_BACKEND_CAPABILITIES).size).toBe(52);
    expect(Object.keys(ENTITY_BACKEND_PROFILES).sort()).toEqual([...STORES].sort());

    for (const store of STORES) {
      const profile = getEntityBackendProfile(store);
      expect(profile.store).toBe(store);
      expect(Object.keys(profile.capabilities)).toHaveLength(ENTITY_BACKEND_CAPABILITIES.length);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.capabilities)).toBe(true);
      for (const claim of Object.values(profile.capabilities)) {
        expect(Object.isFrozen(claim)).toBe(true);
        if (claim.status === 'unsupported') {
          expect(claim.reason.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('classifies production stores and known unsupported semantics explicitly', () => {
    expect(getEntityBackendProfile('memory').production).toBe(false);
    for (const store of ['sqlite', 'postgres', 'mongo', 'redis'] as const) {
      expect(getEntityBackendProfile(store).production).toBe(true);
    }

    expect(getEntityBackendProfile('redis').capabilities['constraint.unique'].status).toBe(
      'unsupported',
    );
    expect(getEntityBackendProfile('redis').capabilities['atomic.increment'].status).toBe(
      'unsupported',
    );
    expect(getEntityBackendProfile('mongo').capabilities['transaction.rollback'].status).toBe(
      'unsupported',
    );
    expect(getEntityBackendProfile('postgres').capabilities['transaction.rollback'].status).toBe(
      'supported',
    );
  });
});
