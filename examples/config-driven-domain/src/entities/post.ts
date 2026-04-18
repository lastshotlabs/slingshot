import { defineEntity, field, index } from '../../../../src/index.ts';

export const Post = defineEntity('Post', {
  namespace: 'blog',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    authorId: field.string(),
    title: field.string(),
    body: field.string(),
    status: field.enum(['draft', 'published', 'archived'] as const, { default: 'draft' }),
    publishedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['status', 'createdAt'], { direction: 'desc' }),
    index(['authorId', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    get: { auth: 'none' },
    list: { auth: 'none' },
    create: {
      permission: {
        requires: 'blog:post.write',
        scope: { resourceType: 'blog:author', resourceId: 'param:authorId' },
      },
      event: { key: 'blog:post.created', payload: ['id', 'authorId', 'title'] },
    },
    clientSafeEvents: ['blog:post.created'],
    permissions: {
      resourceType: 'blog:author',
      scopeField: 'authorId',
      actions: ['read', 'write', 'publish'],
      roles: { owner: ['*'], editor: ['read', 'write'] },
    },
  },
});
