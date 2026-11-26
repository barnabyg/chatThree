import { Hono } from 'hono';
import { z } from 'zod';
import type { KoboldCppStatus, LoadedModelProfile } from '../../shared/api.ts';
import {
  koboldCppAddress,
  type KoboldCppProvider,
  type LoadedModel,
} from '../chat/koboldcpp.ts';
import { type ModelProfiles, PRESETS, ProfileError } from '../chat/profiles.ts';
import { ProviderError } from '../chat/provider.ts';
import { ApiError, readBody } from './errors.ts';

/** What a KoboldCpp address must look like. */
export const ADDRESS_FORMAT =
  'The KoboldCpp address must be a server address such as http://192.168.1.50:5001, with nothing after the port.';

const check = z.strictObject({
  address: z.string().max(500, 'The KoboldCpp address is too long.'),
});

const profileUpdate = z.strictObject({
  preset: z.string().max(100).nullable(),
  // Each field is checked by the profiles, so that a refusal names it.
  overrides: z.record(z.string(), z.unknown()),
});

/**
 * Testing the connection to KoboldCpp, before or after it is saved, and
 * editing the loaded model's profile.
 */
export function koboldCppRoutes(
  koboldcpp: KoboldCppProvider,
  profiles: ModelProfiles,
): Hono {
  const routes = new Hono();

  /** The model KoboldCpp has loaded, or a 502 that says why it is not known. */
  const loaded = async (): Promise<LoadedModel> => {
    try {
      return await koboldcpp.loadedModel();
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ApiError(502, error.message);
      }
      throw error;
    }
  };

  const view = ({ id, contextLength }: LoadedModel): LoadedModelProfile => ({
    model: id,
    contextLength,
    ...profiles.view(id),
    presets: PRESETS.map(({ name, profile }) => ({ name, profile })),
  });

  /** Run `change` on the profiles, reporting what is refused as a 400. */
  const changing = (change: () => void): void => {
    try {
      change();
    } catch (error) {
      if (error instanceof ProfileError) {
        throw new ApiError(400, error.message, error.field);
      }
      if (error instanceof Error) throw new ApiError(409, error.message);
      throw error;
    }
  };

  routes.get('/profile', async (c) => c.json(view(await loaded())));

  routes.put('/profile', async (c) => {
    const update = await readBody(c, profileUpdate);
    const model = await loaded();
    changing(() => {
      profiles.save(model.id, update);
    });
    return c.json(view(model));
  });

  routes.delete('/profile', async (c) => {
    const model = await loaded();
    changing(() => {
      profiles.reset(model.id);
    });
    return c.json(view(model));
  });

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
