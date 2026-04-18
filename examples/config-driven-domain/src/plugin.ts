import { resolveRepo } from '../../../packages/slingshot-core/src/index.ts';
import { createEntityPlugin } from '../../../packages/slingshot-entity/src/index.ts';
import type { BareEntityAdapter } from '../../../packages/slingshot-entity/src/routing/index.ts';
import type { SlingshotPlugin } from '../../../src/index.ts';
import { createEntityFactories } from '../../../src/index.ts';
import { Post } from './entities/post.ts';
import { postOperations } from './entities/postOperations.ts';

export interface BlogPluginConfig {
  mountPath?: string;
}

export function createBlogPlugin(config: BlogPluginConfig = {}): SlingshotPlugin {
  return createEntityPlugin({
    name: 'blog',
    dependencies: ['slingshot-auth'],
    mountPath: config.mountPath ?? '/blog',
    entities: [
      {
        config: Post,
        operations: postOperations.operations,
        buildAdapter: (storeType, infra): BareEntityAdapter =>
          resolveRepo(
            createEntityFactories(Post, postOperations.operations),
            storeType,
            infra,
          ) as unknown as BareEntityAdapter,
      },
    ],
  });
}
