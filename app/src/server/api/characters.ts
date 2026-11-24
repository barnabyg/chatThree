import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Character } from '../../shared/api.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { CharacterStore } from '../store/characters.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 20_000;

const text = (label: string) =>
  z
    .string()
    .trim()
    .max(
      MAX_TEXT_LENGTH,
      `${label} can be at most ${String(MAX_TEXT_LENGTH)} characters.`,
    )
    .default('');

const characterInput = z.strictObject({
  name: z
    .string('A character needs a name.')
    .trim()
    .min(1, 'A character needs a name.')
    .max(
      MAX_NAME_LENGTH,
      `A name can be at most ${String(MAX_NAME_LENGTH)} characters.`,
    ),
  persona: text('The persona'),
  speakingStyle: text('The speaking style'),
  exampleDialogue: text('The example dialogue'),
  appearance: text('The appearance'),
});

export function characterRoutes(
  characters: CharacterStore,
  replies: ReplyService,
): Hono {
  const routes = new Hono();

  const existing = (c: Context): Character => {
    const character = characters.find(c.req.param('id') ?? '');
    if (character === undefined) {
      throw new ApiError(404, 'That character does not exist.');
    }
    return character;
  };

  routes.get('/', (c) => c.json(characters.list()));

  routes.post('/', async (c) =>
    c.json(characters.create(await readBody(c, characterInput)), 201),
  );

  routes.get('/:id', (c) => c.json(existing(c)));

  routes.put('/:id', async (c) => {
    const { id } = existing(c);
    return c.json(characters.update(id, await readBody(c, characterInput)));
  });

  // Deleting a character deletes its chats with it.
  routes.delete('/:id', (c) => {
    const { id } = existing(c);
    if (replies.isReplyingWhere((chat) => chat.character.id === id)) {
      throw new ApiError(
        409,
        'A reply is being written in a chat with this character. Stop it first.',
      );
    }
    characters.delete(id);
    return c.body(null, 204);
  });

  return routes;
}
