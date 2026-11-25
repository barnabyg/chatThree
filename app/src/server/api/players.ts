import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Player } from '../../shared/api.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { Illustrator } from '../scene/illustrator.ts';
import type { PlayerStore } from '../store/players.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 20_000;

const playerInput = z.strictObject({
  name: z
    .string('A player needs a name.')
    .trim()
    .min(1, 'A player needs a name.')
    .max(
      MAX_NAME_LENGTH,
      `A name can be at most ${String(MAX_NAME_LENGTH)} characters.`,
    ),
  background: z
    .string()
    .trim()
    .max(
      MAX_TEXT_LENGTH,
      `The background can be at most ${String(MAX_TEXT_LENGTH)} characters.`,
    )
    .default(''),
});

export function playerRoutes(
  players: PlayerStore,
  replies: ReplyService,
  illustrator: Pick<Illustrator, 'prune'>,
): Hono {
  const routes = new Hono();

  const existing = (c: Context): Player => {
    const player = players.find(c.req.param('id') ?? '');
    if (player === undefined) {
      throw new ApiError(404, 'That player does not exist.');
    }
    return player;
  };

  routes.get('/', (c) => c.json(players.list()));

  routes.post('/', async (c) =>
    c.json(players.create(await readBody(c, playerInput)), 201),
  );

  routes.get('/:id', (c) => c.json(existing(c)));

  routes.put('/:id', async (c) => {
    const { id } = existing(c);
    return c.json(players.update(id, await readBody(c, playerInput)));
  });

  // Deleting a player deletes the chats played as them.
  routes.delete('/:id', (c) => {
    const { id } = existing(c);
    if (replies.isReplyingWhere((chat) => chat.player?.id === id)) {
      throw new ApiError(
        409,
        'A reply is being written in a chat played as this player. Stop it first.',
      );
    }
    players.delete(id);
    // Its chats' pictures went with them.
    illustrator.prune();
    return c.body(null, 204);
  });

  return routes;
}
