import { Hono } from 'hono';
import { z } from 'zod';
import type { KoboldCppStatus } from '../../shared/api.ts';
import { koboldCppAddress, type KoboldCppProvider } from '../chat/koboldcpp.ts';
import { ProviderError } from '../chat/provider.ts';
import { ApiError, readBody } from './errors.ts';

/** What a KoboldCpp address must look like. */
export const ADDRESS_FORMAT =
  'The KoboldCpp address must be a server address such as http://192.168.1.50:5001, with nothing after the port.';

const check = z.strictObject({
  address: z.string().max(500, 'The KoboldCpp address is too long.'),
});

/** Testing the connection to KoboldCpp, before or after it is saved. */
export function koboldCppRoutes(koboldcpp: KoboldCppProvider): Hono {
  const routes = new Hono();

  routes.post('/check', async (c) => {
    const { address: typed } = await readBody(c, check);
    const address = koboldCppAddress(typed);
    if (address === undefined || address === '') {
      throw new ApiError(400, ADDRESS_FORMAT);
    }
    try {
      const { id, contextLength } = await koboldcpp.check(address);
      return c.json({ model: id, contextLength } satisfies KoboldCppStatus);
    } catch (error) {
      if (error instanceof ProviderError)
        throw new ApiError(502, error.message);
      throw error;
    }
  });

  return routes;
}
