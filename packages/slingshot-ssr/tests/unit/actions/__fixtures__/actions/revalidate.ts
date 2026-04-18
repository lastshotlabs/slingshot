import { revalidatePath, revalidateTag } from '../../../../../src/actions/context';

export async function touchPath(pathname = '/posts'): Promise<{ ok: true }> {
  await revalidatePath(pathname);
  return { ok: true };
}

export async function touchTag(tag = 'posts'): Promise<{ ok: true }> {
  await revalidateTag(tag);
  return { ok: true };
}
