import { z } from 'zod';
import { ValidationError } from '@lastshotlabs/slingshot-core';

export const validate = async <T extends z.ZodType>(
  schema: T,
  req: Request,
): Promise<z.output<T>> => {
  try {
    const body: unknown = await req.json();
    return schema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ValidationError(err.issues);
    }
    throw err;
  }
};
