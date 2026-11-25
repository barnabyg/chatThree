import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { ReplyPrompt } from '../../shared/api.ts';
import type { ReplyPromptStore } from '../store/replyPrompts.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_PROMPT_LENGTH = 20_000;

const replyPromptInput = z.strictObject({
  name: z
    .string('A reply prompt needs a name.')
    .trim()
    .min(1, 'A reply prompt needs a name.')
    .max(
      MAX_NAME_LENGTH,
      `A name can be at most ${String(MAX_NAME_LENGTH)} characters.`,
    ),
  prompt: z
    .string('Write the reply prompt.')
    .trim()
    .min(1, 'Write the reply prompt.')
    .max(
      MAX_PROMPT_LENGTH,
      `A reply prompt can be at most ${String(MAX_PROMPT_LENGTH)} characters.`,
    ),
});

export function replyPromptRoutes(replyPrompts: ReplyPromptStore): Hono {
  const routes = new Hono();

  const existing = (c: Context): ReplyPrompt => {
    const replyPrompt = replyPrompts.find(c.req.param('id') ?? '');
    if (replyPrompt === undefined) {
      throw new ApiError(404, 'That reply prompt does not exist.');
    }
    return replyPrompt;
  };

  routes.get('/', (c) => c.json(replyPrompts.list()));

  routes.post('/', async (c) =>
    c.json(replyPrompts.create(await readBody(c, replyPromptInput)), 201),
  );

  routes.get('/:id', (c) => c.json(existing(c)));

  routes.put('/:id', async (c) => {
    const { id } = existing(c);
    return c.json(replyPrompts.update(id, await readBody(c, replyPromptInput)));
  });

  // The chats that used it go back to the default; a reply already being
  // written keeps the prompt it started with.
  routes.delete('/:id', (c) => {
    replyPrompts.delete(existing(c).id);
    return c.body(null, 204);
  });

  return routes;
}
