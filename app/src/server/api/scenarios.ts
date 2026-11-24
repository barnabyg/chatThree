import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Scenario } from '../../shared/api.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { Illustrator } from '../scene/illustrator.ts';
import type { ScenarioStore } from '../store/scenarios.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 20_000;

const name = (label: string) =>
  z
    .string()
    .trim()
    .max(
      MAX_NAME_LENGTH,
      `${label} can be at most ${String(MAX_NAME_LENGTH)} characters.`,
    )
    .default('');

const text = (label: string) =>
  z
    .string()
    .trim()
    .max(
      MAX_TEXT_LENGTH,
      `${label} can be at most ${String(MAX_TEXT_LENGTH)} characters.`,
    )
    .default('');

const scenarioInput = z.strictObject({
  title: z
    .string('A scenario needs a title.')
    .trim()
    .min(1, 'A scenario needs a title.')
    .max(
      MAX_NAME_LENGTH,
      `A title can be at most ${String(MAX_NAME_LENGTH)} characters.`,
    ),
  premise: text('The premise'),
  userPersona: z
    .strictObject({
      name: name("Your character's name"),
      description: text("Your character's description"),
    })
    .default({ name: '', description: '' }),
  openingMessage: text('The opening message'),
  startingLocation: z
    .strictObject({
      name: name("The starting location's name"),
      description: text("The starting location's description"),
    })
    .default({ name: '', description: '' }),
});

export function scenarioRoutes(
  scenarios: ScenarioStore,
  replies: ReplyService,
  illustrator: Pick<Illustrator, 'prune'>,
): Hono {
  const routes = new Hono();

  const existing = (c: Context): Scenario => {
    const scenario = scenarios.find(c.req.param('id') ?? '');
    if (scenario === undefined) {
      throw new ApiError(404, 'That scenario does not exist.');
    }
    return scenario;
  };

  routes.get('/', (c) => c.json(scenarios.list()));

  routes.post('/', async (c) =>
    c.json(scenarios.create(await readBody(c, scenarioInput)), 201),
  );

  routes.get('/:id', (c) => c.json(existing(c)));

  routes.put('/:id', async (c) => {
    const { id } = existing(c);
    return c.json(scenarios.update(id, await readBody(c, scenarioInput)));
  });

  // Deleting a scenario deletes its chats with it.
  routes.delete('/:id', (c) => {
    const { id } = existing(c);
    if (replies.isReplyingWhere((chat) => chat.scenario.id === id)) {
      throw new ApiError(
        409,
        'A reply is being written in a chat set in this scenario. Stop it first.',
      );
    }
    scenarios.delete(id);
    // Its chats' pictures went with them.
    illustrator.prune();
    return c.body(null, 204);
  });

  return routes;
}
