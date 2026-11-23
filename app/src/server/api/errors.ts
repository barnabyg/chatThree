import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

/** A request the API refuses, with a message written for the user. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read and validate a JSON request body, or throw a 400 `ApiError`. */
export async function readBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError(400, 'The request body is not valid JSON.');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(
      400,
      result.error.issues[0]?.message ?? 'The request is not valid.',
    );
  }
  return result.data;
}
