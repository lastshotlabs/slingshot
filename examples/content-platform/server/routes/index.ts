import type { SsrLoadResult } from '../../../../packages/slingshot-ssr/src/index.ts';
import { defineRoute } from '../../../../packages/slingshot-ssr/src/index.ts';

const route = defineRoute({
  load: async (): Promise<SsrLoadResult<{ page: string }>> => ({
    data: { page: 'home' },
    revalidate: false,
  }),
  Page: ({ loaderData }) => `<h1>${loaderData.page}</h1>`,
});

export const { load } = route;
export default route.Page;
