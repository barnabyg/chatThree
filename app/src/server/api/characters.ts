import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type Character, MIN_VOICE_SECONDS } from '../../shared/api.ts';
import { wavSeconds } from '../../shared/wav.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { VoiceWarmer } from '../engine/warmer.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { MediaStore } from '../store/media.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 20_000;
/** Room for several minutes of recording; the UI sends half a minute. */
const MAX_VOICE_CLIP_BYTES = 25 * 1024 * 1024;

/** Check that a voice can be cloned from an uploaded clip, or refuse it. */
function checkVoiceClip(clip: Uint8Array): void {
  const seconds = wavSeconds(clip);
  if (seconds === undefined) {
    throw new ApiError(400, 'A voice clip must be a WAV recording.');
  }
  if (seconds <= MIN_VOICE_SECONDS) {
    throw new ApiError(
      400,
      `That recording is ${seconds.toFixed(1)} seconds long. A voice clip must be longer than ${String(MIN_VOICE_SECONDS)} seconds.`,
    );
  }
}

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
  media: MediaStore,
  warmer: VoiceWarmer,
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
    const voice = characters.voiceFile(id);
    characters.delete(id);
    if (voice !== undefined) media.remove(voice);
    return c.body(null, 204);
  });

  /** Put `file` in place of the character's voice clip, or take the clip away. */
  const replaceVoice = (id: string, file: string | null): Character => {
    const old = characters.voiceFile(id);
    characters.setVoiceFile(id, file);
    if (old !== undefined) media.remove(old);
    const character = characters.find(id);
    if (character === undefined) throw new Error(`Character ${id} has gone.`);
    return character;
  };

  // Give the character a voice. The body is the clip itself, a WAV file.
  routes.put(
    '/:id/voice',
    bodyLimit({
      maxSize: MAX_VOICE_CLIP_BYTES,
      onError: () => {
        throw new ApiError(413, 'That recording is too large to use.');
      },
    }),
    async (c) => {
      const { id } = existing(c);
      const clip = new Uint8Array(await c.req.arrayBuffer());
      checkVoiceClip(clip);
      return c.json(replaceVoice(id, media.save('voices', 'wav', clip)));
    },
  );

  // Back to the engine's built-in voice.
  routes.delete('/:id/voice', (c) =>
    c.json(replaceVoice(existing(c).id, null)),
  );

  // Have the character's voice ready before it first speaks. Asked for when
  // a chat opens; it answers at once and the engine does the work after.
  routes.post('/:id/voice/warm', (c) => {
    const voice = characters.voiceFile(existing(c).id);
    if (voice !== undefined) warmer.warm(media.path(voice));
    return c.body(null, 204);
  });

  return routes;
}
