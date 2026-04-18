/**
 * Tests for buildAssetlinksBody and serializeAssetlinksBody.
 */
import { describe, expect, test } from 'bun:test';
import { buildAssetlinksBody, serializeAssetlinksBody } from '../src/assetlinks';
import type { AndroidAppLink } from '../src/config';

const android: AndroidAppLink = {
  packageName: 'com.example.app',
  sha256Fingerprints: [
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
  ],
};

describe('buildAssetlinksBody — structure', () => {
  test('returns null when android is undefined', () => {
    expect(buildAssetlinksBody(undefined)).toBeNull();
  });

  test('returns an array with exactly one entry', () => {
    const body = buildAssetlinksBody(android);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  test('relation is always delegate_permission/common.handle_all_urls', () => {
    const body = buildAssetlinksBody(android);
    expect(body![0]!.relation).toEqual(['delegate_permission/common.handle_all_urls']);
  });

  test('namespace is always android_app', () => {
    const body = buildAssetlinksBody(android);
    expect(body![0]!.target.namespace).toBe('android_app');
  });

  test('package_name matches config', () => {
    const body = buildAssetlinksBody(android);
    expect(body![0]!.target.package_name).toBe('com.example.app');
  });

  test('sha256_cert_fingerprints includes all fingerprints', () => {
    const body = buildAssetlinksBody(android);
    expect(body![0]!.target.sha256_cert_fingerprints).toHaveLength(2);
    expect(body![0]!.target.sha256_cert_fingerprints).toContain(android.sha256Fingerprints[0]);
    expect(body![0]!.target.sha256_cert_fingerprints).toContain(android.sha256Fingerprints[1]);
  });
});

describe('serializeAssetlinksBody', () => {
  test('returns null when android is undefined', () => {
    expect(serializeAssetlinksBody(undefined)).toBeNull();
  });

  test('returns valid JSON string', () => {
    const json = serializeAssetlinksBody(android);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  test('serialized JSON matches buildAssetlinksBody output', () => {
    const body = buildAssetlinksBody(android);
    const json = serializeAssetlinksBody(android);
    expect(json).toBe(JSON.stringify(body));
  });
});
