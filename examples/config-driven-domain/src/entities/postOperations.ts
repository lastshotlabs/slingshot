import { defineOperations, op } from '../../../../src/index.ts';
import { Post } from './post.ts';

export const postOperations = defineOperations(Post, {
  publish: op.transition({
    field: 'status',
    from: 'draft',
    to: 'published',
    match: { id: 'param:id' },
    set: { publishedAt: 'now' },
    returns: 'entity',
  }),
  archive: op.transition({
    field: 'status',
    from: ['draft', 'published'],
    to: 'archived',
    match: { id: 'param:id' },
    returns: 'entity',
  }),
  search: op.search({
    fields: ['title', 'body'],
    filter: { status: 'published' },
    paginate: true,
  }),
});
