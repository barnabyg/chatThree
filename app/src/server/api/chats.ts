import { type Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import type { Chat, ChatSummary, ReplyEvent } from '../../shared/api.ts';
import { BUILT_IN_CHARACTER, BUILT_IN_SCENARIO } from '../chat/builtin.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { ChatStore } from '../store/chats.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_MESSAGE_LENGTH = 20_000;

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
): Response {
  c.header('Content-Type', 'application/x-ndjson');
  c.header('Cache-Control', 'no-cache');
  return stream(c, async (body) => {
    body.onAbort(onAbandoned);
    for await (const event of events) {
      if (body.aborted) continue;
      await body.write(`${JSON.stringify(event)}\n`);
    }
  });
}

export function chatRoutes(chats: ChatStore, replies: ReplyService): Hono {
  const routes = new Hono();

  const existing = (c: Context): ChatSummary => {
    const chat = chats.find(c.req.param('id') ?? '');
    if (chat === undefined)
      throw new ApiError(404, 'That chat does not exist.');
    return chat;
  };

  const view = ({ id }: ChatSummary): Chat => ({
    id,
    character: { name: BUILT_IN_CHARACTER.name },
    scenario: { title: BUILT_IN_SCENARIO.title },
    messages: chats.messages(id),
    replying: replies.isReplying(id),
  });

  routes.get('/', (c) => c.json(chats.list()));

  routes.post('/', (c) => c.json(view(chats.create()), 201));

  routes.get('/:id', (c) => c.json(view(existing(c))));

  // Send a message. The answer is a stream of reply events.
  routes.post('/:id/messages', async (c) => {
    const chat = existing(c);
    const { content } = await readBody(c, newMessage);
    return streamReply(c, replies.send(chat.id, content), () => {
      replies.stop(chat.id);
    });
  });

  // Replace the last reply with a new one. The answer is a stream of reply events.
  routes.post('/:id/regenerate', (c) => {
    const chat = existing(c);
    return streamReply(c, replies.regenerate(chat.id), () => {
      replies.stop(chat.id);
    });
  });

  routes.delete('/:id/messages/last', (c) => {
    const chat = existing(c);
    replies.deleteLastMessage(chat.id);
    return c.json(view(chat));
  });

  // Stop the reply being written. What has arrived so far is kept.
  routes.post('/:id/stop', (c) => {
    replies.stop(existing(c).id);
    return c.body(null, 204);
  });

  return routes;
}
