import { Hono } from 'hono';
import { z } from 'zod';
import { isWellFormedApiKey } from '../apiKey.ts';
import type { SettingsStore } from '../settings.ts';
import { readBody } from './errors.ts';

const MIN_TOKEN_BUDGET = 100;
const MAX_TOKEN_BUDGET = 1_000_000;

const update = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1, 'The model name cannot be empty.')
    .max(200, 'The model name is too long.')
    .optional(),
  sceneModel: z
    .string()
    .trim()
    .min(1, 'The scene model name cannot be empty.')
    .max(200, 'The scene model name is too long.')
    .optional(),
  contextTokenBudget: z
    .int('The conversation budget must be a whole number of tokens.')
    .min(
      MIN_TOKEN_BUDGET,
      `The conversation budget must be at least ${String(MIN_TOKEN_BUDGET)} tokens.`,
    )
    .max(
      MAX_TOKEN_BUDGET,
      `The conversation budget can be at most ${String(MAX_TOKEN_BUDGET)} tokens.`,
    )
    .optional(),
  speechMuted: z
    .boolean('Whether replies are spoken must be true or false.')
    .optional(),
  speechScope: z
    .enum(
      ['dialogue', 'everything'],
      'What is spoken must be "dialogue" or "everything".',
    )
    .optional(),
  apiKey: z
    .string()
    .trim()
    .min(1, 'The API key cannot be empty.')
    .max(500, 'The API key is too long.')
    .refine(
      isWellFormedApiKey,
      'An API key cannot contain spaces, line breaks or other special characters.',
    )
    .nullable()
    .optional(),
});

/** Settings as the browser may see them. The API key is write-only. */
export function settingsRoutes(settings: SettingsStore): Hono {
  const routes = new Hono();

  routes.get('/', (c) => c.json(settings.view()));

  routes.put('/', async (c) => {
    const {
      model,
      sceneModel,
      contextTokenBudget,
      speechMuted,
      speechScope,
      apiKey,
    } = await readBody(c, update);
    return c.json(
      settings.update({
        ...(model !== undefined && { model }),
        ...(sceneModel !== undefined && { sceneModel }),
        ...(contextTokenBudget !== undefined && { contextTokenBudget }),
        ...(speechMuted !== undefined && { speechMuted }),
        ...(speechScope !== undefined && { speechScope }),
        ...(apiKey !== undefined && { apiKey }),
      }),
    );
  });

  return routes;
}
