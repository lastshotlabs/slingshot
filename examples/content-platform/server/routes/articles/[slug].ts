import type {
  GenerateStaticParams,
  SsrLoadResult,
} from '../../../../../packages/slingshot-ssr/src/index.ts';
import { defineRoute } from '../../../../../packages/slingshot-ssr/src/index.ts';

const route = defineRoute({
  load: async (ctx): Promise<SsrLoadResult<{ slug: string }>> => ({
    data: { slug: ctx.params.slug },
    revalidate: false,
    tags: [`article:${ctx.params.slug}`],
  }),
  Page: ({ loaderData }) => `<article>${loaderData.slug}</article>`,
  generateStaticParams: (async () => [
    { slug: 'hello-world' },
    { slug: 'release-notes' },
  ]) satisfies GenerateStaticParams,
});

export const { load, generateStaticParams } = route;
export default route.Page;
