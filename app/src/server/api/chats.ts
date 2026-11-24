import { type Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import path from 'node:path';
import type {
  Chat,
  ChatSummary,
  Location,
  ReplyEvent,
} from '../../shared/api.ts';
import type { ReplyService } from '../chat/replies.ts';
import { countNotSent } from '../chat/trim.ts';
import { startingPlace } from '../scene/describe.ts';
import type { Illustrator } from '../scene/illustrator.ts';
import type { SettingsStore } from '../settings.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { ChatStore } from '../store/chats.ts';
import type { MediaStore } from '../store/media.ts';
import type { ScenarioStore } from '../store/scenarios.ts';
import type { SceneStore, StoredLocation } from '../store/scenes.ts';
import { engineFailure, NOT_PAINTED } from './engineFailures.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_MESSAGE_LENGTH = 20_000;

const newChat = z.strictObject({
  characterId: z.string('Choose a character for the chat.'),
  scenarioId: z.string('Choose a scenario for the chat.'),
});

const newMessage = z.strictObject({
  content: z
    .string()
    .trim()
    .min(1, 'Type a message first.')
    .max(
      MAX_MESSAGE_LENGTH,
      `A message can be at most ${String(MAX_MESSAGE_LENGTH)} characters.`,
    ),
});

/**
 * Answer with reply events, one JSON object per line, as they happen.
 * The events are read to the end even if the browser goes away, because the
 * reply is saved as its last step; `onAbandoned` should end the reply early.
 */
function streamReply(
  c: Context,
  events: AsyncIterable<ReplyEvent>,
  onAbandoned: () => void,
  onFinished: () => void = () => undefined,
): Response {
  c.header('Content-Type', 'application/x-ndjson');
  c.header('Cache-Control', 'no-cache');
  return stream(c, async (body) => {
    body.onAbort(onAbandoned);
    try {
      for await (const event of events) {
        if (body.aborted) continue;
        await body.write(`${JSON.stringify(event)}\n`);
      }
    } finally {
      onFinished();
    }
  });
}

/** A whole number from a route parameter, or `undefined` if it is not one. */
function idParam(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,15}$/.test(value)
    ? Number(value)
    : undefined;
}

/** Serve a picture the app made, which never changes once made. */
function servePng(c: Context, picture: Uint8Array<ArrayBuffer>): Response {
  return c.body(picture, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
}

/** A place as the browser sees it. */
function toLocation(
  chatId: string,
  { imageFile, ...place }: StoredLocation,
): Location {
  return {
    ...place,
    // The file's name is in the address, as for a character's picture.
    imageUrl:
      imageFile === undefined
        ? null
        : `/api/chats/${chatId}/locations/${String(place.id)}/image?v=${encodeURIComponent(path.parse(imageFile).name)}`,
  };
}

/** What the chat routes work with. */
export interface ChatRouteDependencies {
  chats: ChatStore;
  characters: CharacterStore;
  scenarios: ScenarioStore;
  scenes: SceneStore;
  replies: ReplyService;
  illustrator: Illustrator;
  settings: SettingsStore;
  media: MediaStore;
}

export function chatRoutes({
  chats,
  characters,
  scenarios,
  scenes,
  replies,
  illustrator,
  settings,
  media,
}: ChatRouteDependencies): Hono {
  const routes = new Hono();

  const existing = (c: Context): ChatSummary => {
    const chat = chats.find(c.req.param('id') ?? '');
    if (chat === undefined)
      throw new ApiError(404, 'That chat does not exist.');
    return chat;
  };

  const view = ({ id, character, scenario }: ChatSummary): Chat => {
    const messages = chats.messages(id);
    const ids = new Set(messages.map((message) => message.id));
    const start = scenarios.find(scenario.id);
    if (start === undefined)
      throw new Error(`Chat ${id} has lost its scenario.`);
    // A chat records where it began the first time it is looked at.
    const current = toLocation(
      id,
      scenes.currentLocation(id, startingPlace(start)),
    );
    return {
      id,
      character: {
        ...character,
        imageUrl: characters.find(character.id)?.imageUrl ?? null,
      },
      scenario,
      messages,
      location: current,
      locations: scenes.locations(id).map((place) => toLocation(id, place)),
      illustrations: scenes.illustrations(id).map((illustration) => ({
        ...illustration,
        imageUrl: `/api/chats/${id}/illustrations/${String(illustration.id)}/image`,
      })),
      // A failure stays until it is tried again, unless its message has gone.
      illustrating: illustrator
        .progress(id)
        .filter(({ messageId }) => ids.has(messageId)),
      followingScene: illustrator.isFollowing(id),
      notSent: countNotSent(messages, settings.contextTokenBudget()),
      replying: replies.isReplying(id),
    };
  };

  routes.get('/', (c) => c.json(chats.list()));

  routes.post('/', async (c) => {
    const { characterId, scenarioId } = await readBody(c, newChat);
    if (characters.find(characterId) === undefined) {
      throw new ApiError(400, 'That character does not exist.');
    }
    const scenario = scenarios.find(scenarioId);
    if (scenario === undefined) {
      throw new ApiError(400, 'That scenario does not exist.');
    }
    return c.json(
      view(chats.create(characterId, scenarioId, scenario.openingMessage)),
      201,
    );
  });

  routes.get('/:id', (c) => c.json(view(existing(c))));

  routes.delete('/:id', (c) => {
    const chat = existing(c);
    if (replies.isReplying(chat.id)) {
      throw new ApiError(
        409,
        'A reply is being written in this chat. Stop it first.',
      );
    }
    chats.delete(chat.id);
    illustrator.prune();
    return c.body(null, 204);
  });

  // Send a message. The answer is a stream of reply events.
  routes.post('/:id/messages', async (c) => {
    const chat = existing(c);
    const { content } = await readBody(c, newMessage);
    return streamReply(c, replies.send(chat.id, content), () => {
      replies.stop(chat.id);
    });
  });

  // Replace the last reply with a new one. The answer is a stream of reply events.
  // The replaced reply's illustrations go with it.
  routes.post('/:id/regenerate', (c) => {
    const chat = existing(c);
    return streamReply(
      c,
      replies.regenerate(chat.id),
      () => {
        replies.stop(chat.id);
      },
      () => {
        illustrator.prune();
      },
    );
  });

  routes.delete('/:id/messages/last', (c) => {
    const chat = existing(c);
    replies.deleteLastMessage(chat.id);
    illustrator.prune();
    return c.json(view(chat));
  });

  // Start illustrating one of the character's messages. The answer is the
  // chat, showing the illustration under way; it appears there when done.
  routes.post('/:id/messages/:messageId/illustrate', (c) => {
    const chat = existing(c);
    const messageId = idParam(c.req.param('messageId'));
    if (messageId === undefined) {
      throw new ApiError(404, 'That message is not in this chat.');
    }
    illustrator.illustrate(chat.id, messageId);
    return c.json(view(chat), 202);
  });

  // A place's reference picture. As for a character's, an address with a
  // version only ever serves that picture.
  routes.get('/:id/locations/:locationId/image', (c) => {
    const chat = existing(c);
    const id = idParam(c.req.param('locationId'));
    const file =
      id === undefined ? undefined : scenes.location(chat.id, id)?.imageFile;
    const version = c.req.query('v');
    const picture =
      file === undefined ||
      (version !== undefined && version !== path.parse(file).name)
        ? undefined
        : media.read(file);
    if (picture === undefined) {
      throw new ApiError(404, 'That place has no such picture.');
    }
    return servePng(c, picture);
  });

  // Paint a new reference picture of one of the chat's places. Later
  // illustrations there are painted from it.
  routes.post('/:id/locations/:locationId/image/generate', async (c) => {
    const chat = existing(c);
    const id = idParam(c.req.param('locationId'));
    if (id === undefined || scenes.location(chat.id, id) === undefined) {
      throw new ApiError(404, 'That place is not in this chat.');
    }
    try {
      await illustrator.repaintPlace(chat.id, id);
    } catch (error) {
      throw engineFailure(error, NOT_PAINTED);
    }
    return c.json(view(existing(c)));
  });

  // One of the chat's illustrations. Its address only ever serves that picture.
  routes.get('/:id/illustrations/:illustrationId/image', (c) => {
    const chat = existing(c);
    const id = idParam(c.req.param('illustrationId'));
    const file =
      id === undefined ? undefined : scenes.illustrationFile(chat.id, id);
    const picture = file === undefined ? undefined : media.read(file);
    if (picture === undefined) {
      throw new ApiError(404, 'That chat has no such picture.');
    }
    return servePng(c, picture);
  });

  // Stop the reply being written. What has arrived so far is kept.
  routes.post('/:id/stop', (c) => {
    replies.stop(existing(c).id);
    return c.body(null, 204);
  });

  return routes;
}
