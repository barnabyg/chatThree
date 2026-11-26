import { Hono } from 'hono';
import type { ModelList, ModelReasoning } from '../../shared/api.ts';
import type { ModelCatalog } from '../chat/models.ts';
import { ProviderError } from '../chat/provider.ts';
import { ApiError } from './errors.ts';

/** Run `ask`, reporting the text backend's failure as a 502 with its message. */
async function fromBackend<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof ProviderError) throw new ApiError(502, error.message);
    throw error;
  }
}

/** The models that can write replies, and the thinking levels each takes. */
export function modelRoutes(catalog: ModelCatalog): Hono {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const models = await fromBackend(() => catalog.models());
    return c.json({ models } satisfies ModelList);
  });

  routes.get('/:model/reasoning', async (c) => {
    const model = c.req.param('model');
    if (model.length > 200) {
      throw new ApiError(400, 'The model name is too long.');
    }
    const efforts = await fromBackend(() => catalog.reasoningEfforts(model));
    return c.json({ efforts } satisfies ModelReasoning);
  });

  return routes;
}
