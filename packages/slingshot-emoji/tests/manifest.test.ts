import { describe, expect, test } from 'bun:test';
import { emojiManifest } from '../src/emoji';

describe('slingshot-emoji manifest', () => {
  test('declares the expected entity fields with correct types', () => {
    const fields = emojiManifest.entities.Emoji.fields;

    expect(fields.id).toEqual({ type: 'string', primary: true, default: 'uuid' });
    expect(fields.orgId).toEqual({ type: 'string' });
    expect(fields.name).toEqual({ type: 'string' });
    expect(fields.shortcode).toEqual({ type: 'string' });
    expect(fields.category).toEqual({ type: 'string', optional: true });
    expect(fields.animated).toEqual({ type: 'boolean', default: false });
    expect(fields.uploadKey).toEqual({ type: 'string' });
    expect(fields.createdBy).toEqual({ type: 'string' });
    expect(fields.createdAt).toEqual({ type: 'date', default: 'now' });
  });

  test('defines the orgId+shortcode unique index', () => {
    const indexes = emojiManifest.entities.Emoji.indexes;

    expect(indexes).toContainEqual({ fields: ['orgId', 'shortcode'], unique: true });
  });

  test('defines indexes for orgId and orgId+category lookups', () => {
    const indexes = emojiManifest.entities.Emoji.indexes;

    expect(indexes).toContainEqual({ fields: ['orgId'] });
    expect(indexes).toContainEqual({ fields: ['orgId', 'category'] });
  });

  test('defines listByOrg, getByShortcode, and listByCategory operations', () => {
    const ops = emojiManifest.entities.Emoji.operations;

    expect(ops?.listByOrg).toEqual({
      kind: 'lookup',
      fields: { orgId: 'param:orgId' },
      returns: 'many',
    });

    expect(ops?.getByShortcode).toEqual({
      kind: 'lookup',
      fields: { orgId: 'param:orgId', shortcode: 'param:shortcode' },
      returns: 'one',
    });

    expect(ops?.listByCategory).toEqual({
      kind: 'lookup',
      fields: { orgId: 'param:orgId', category: 'param:category' },
      returns: 'many',
    });
  });

  test('requires userAuth for all routes by default', () => {
    const routes = emojiManifest.entities.Emoji.routes;

    expect(routes?.defaults).toEqual({ auth: 'userAuth' });
  });

  test('guards list and get with emoji:emoji.read permission', () => {
    const routes = emojiManifest.entities.Emoji.routes;

    expect(routes?.list).toMatchObject({ permission: { requires: 'emoji:emoji.read' } });
    expect(routes?.get).toMatchObject({ permission: { requires: 'emoji:emoji.read' } });
  });

  test('guards create with emoji:emoji.write permission and emits emoji:emoji.created', () => {
    const routes = emojiManifest.entities.Emoji.routes;

    expect(routes?.create).toMatchObject({
      permission: { requires: 'emoji:emoji.write' },
      event: {
        key: 'emoji:emoji.created',
        payload: ['id', 'shortcode', 'name', 'orgId', 'createdBy'],
        exposure: ['client-safe'],
      },
    });
  });

  test('guards delete with emoji:emoji.delete permission and emits emoji:emoji.deleted', () => {
    const routes = emojiManifest.entities.Emoji.routes;

    expect(routes?.delete).toMatchObject({
      permission: { requires: 'emoji:emoji.delete' },
      event: {
        key: 'emoji:emoji.deleted',
        payload: ['id', 'shortcode', 'uploadKey', 'orgId'],
        exposure: ['client-safe'],
      },
    });
  });

  test('disables the update route', () => {
    const routes = emojiManifest.entities.Emoji.routes;

    expect(routes?.disable).toEqual(['update']);
  });

  test('operations routes are permission-guarded with emoji:emoji.read', () => {
    const operationRoutes = emojiManifest.entities.Emoji.routes?.operations;

    expect(operationRoutes?.listByOrg).toEqual({ permission: { requires: 'emoji:emoji.read' } });
    expect(operationRoutes?.getByShortcode).toEqual({
      permission: { requires: 'emoji:emoji.read' },
    });
    expect(operationRoutes?.listByCategory).toEqual({
      permission: { requires: 'emoji:emoji.read' },
    });
  });

  test('declares permission resource type, actions, and role mappings', () => {
    const perms = emojiManifest.entities.Emoji.routes?.permissions;

    expect(perms).toEqual({
      resourceType: 'emoji:emoji',
      actions: ['read', 'write', 'delete'],
      roles: {
        'org:admin': ['*'],
        'org:member': ['read', 'write'],
      },
    });
  });

  test('manifest namespace is "emoji"', () => {
    expect(emojiManifest.namespace).toBe('emoji');
  });

  test('manifest version is 1', () => {
    expect(emojiManifest.manifestVersion).toBe(1);
  });
});
