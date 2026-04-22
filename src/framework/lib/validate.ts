import { z } from 'zod';
import { ValidationError } from '@lastshotlabs/slingshot-core';

/**
 * Parse and validate the JSON body of a `Request` against a Zod schema.
 *
 * @param schema - The Zod schema to validate against.
 * @param req - The incoming `Request` whose body will be parsed as JSON.
 * @returns The validated and typed output.
 * @throws {ValidationError} When the body does not conform to the schema.
 */
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
