import { Hono } from 'hono';
import { z } from 'zod';
import type { SettingsStore } from '../settings.ts';
import { readBody } from './errors.ts';

const update = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1, 'The model name cannot be empty.')
    .max(200, 'The model name is too long.')
    .optional(),
  apiKey: z
    .string()
    .trim()
    .min(1, 'The API key cannot be empty.')
    .max(500, 'The API key is too long.')
    .nullable()
    .optional(),
});

/** Settings as the browser may see them. The API key is write-only. */
export function settingsRoutes(settings: SettingsStore): Hono {
  const routes = new Hono();

  routes.get('/', (c) => c.json(settings.view()));

  routes.put('/', async (c) => {
    const { model, apiKey } = await readBody(c, update);
    return c.json(
      settings.update({
        ...(model !== undefined && { model }),
        ...(apiKey !== undefined && { apiKey }),
      }),
    );
  });

  return routes;
}
