import { randomInt } from 'node:crypto';
import path from 'node:path';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Character } from '../../shared/api.ts';
import { voiceClipProblem } from '../../shared/voiceClip.ts';
import type { ReplyService } from '../chat/replies.ts';
import type { EngineJobs } from '../engine/jobs.ts';
import type { VoiceWarmer } from '../engine/warmer.ts';
import type { Illustrator } from '../scene/illustrator.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { MediaStore } from '../store/media.ts';
import { engineFailure, NOT_PAINTED } from './engineFailures.ts';
import { ApiError, readBody } from './errors.ts';

const MAX_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 20_000;
/** Room for several minutes of recording; the UI sends half a minute. */
const MAX_VOICE_CLIP_BYTES = 25 * 1024 * 1024;

const MAX_PICTURE_BYTES = 15 * 1024 * 1024;
/** Upright, to show a whole figure. Each side is a multiple of 16, as the engine needs. */
const REFERENCE_SIZE = { width: 768, height: 1024 };
/** Seeds are drawn from below this: plenty of pictures, and a whole number any engine takes. */
const MAX_SEED = 2 ** 31;

/** What the engine is asked to paint for a character who looks like this. */
export function referencePrompt(appearance: string): string {
  return [
    'A character reference picture for an illustrated story.',
    appearance,
    'One person only, standing, shown from head to knees and facing the viewer, with a neutral expression, against a plain pale background in soft, even light. No text.',
  ].join(' ');
}

const PICTURE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/** The kind of picture these bytes are, as a file extension, if it is one the app keeps. */
function pictureKind(bytes: Uint8Array): string | undefined {
  /** Whether the file begins with these bytes. `undefined` matches any byte. */
  const starts = (...head: (number | undefined)[]): boolean =>
    head.every((byte, index) => byte === undefined || bytes[index] === byte);
  const ascii = (offset: number, word: string): boolean =>
    starts(...Array<undefined>(offset), ...Buffer.from(word, 'ascii'));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  return undefined;
}

/** Check that a voice can be cloned from an uploaded clip, or refuse it. */
function checkVoiceClip(clip: Uint8Array): void {
  const problem = voiceClipProblem(clip);
  if (problem !== undefined) throw new ApiError(400, problem);
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

const pictureRequest = z.strictObject({
  /** The appearance to draw from, if not the one last saved. */
  appearance: z
    .string()
    .trim()
    .max(
      MAX_TEXT_LENGTH,
      `The appearance can be at most ${String(MAX_TEXT_LENGTH)} characters.`,
    )
    .optional(),
});

export function characterRoutes(
  characters: CharacterStore,
  replies: ReplyService,
  media: MediaStore,
  warmer: VoiceWarmer,
  jobs: EngineJobs,
  illustrator: Pick<Illustrator, 'prune'>,
): Hono {
  const routes = new Hono();

  const existing = (c: Context): Character => {
    const character = characters.find(c.req.param('id') ?? '');
    if (character === undefined) {
      throw new ApiError(404, 'That character does not exist.');
    }
    return character;
  };

  /**
   * Finish replacing one of the character's files: `record` the new one,
   * delete the `old` one it takes the place of, and return the character as
   * it now is.
   */
  const replaced = (
    id: string,
    old: string | undefined,
    record: () => void,
  ): Character => {
    record();
    if (old !== undefined) media.remove(old);
    const character = characters.find(id);
    if (character === undefined) throw new Error(`Character ${id} has gone.`);
    return character;
  };

  const setVoice = (id: string, file: string | null): Character =>
    replaced(id, characters.voiceFile(id), () => {
      characters.setVoiceFile(id, file);
    });

  const setPicture = (id: string, file: string): Character =>
    replaced(id, characters.imageFile(id), () => {
      characters.setImageFile(id, file);
    });

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
    const files = [characters.voiceFile(id), characters.imageFile(id)];
    characters.delete(id);
    for (const file of files) if (file !== undefined) media.remove(file);
    // Its chats' pictures went with them.
    illustrator.prune();
    return c.body(null, 204);
  });

  // Have the engine paint the character's reference picture from its
  // appearance: the one sent, which may not be saved yet, or else the saved
  // one. Every request paints a new picture.
  routes.post('/:id/image/generate', async (c) => {
    const character = existing(c);
    const { appearance = character.appearance } = await readBody(
      c,
      pictureRequest,
    );
    if (appearance === '') {
      throw new ApiError(
        400,
        'Describe the appearance first: the picture is made from it.',
      );
    }
    const before = characters.imageFile(character.id);
    let picture: Uint8Array;
    try {
      picture = await jobs.paint({
        prompt: referencePrompt(appearance),
        ...REFERENCE_SIZE,
        seed: randomInt(MAX_SEED),
      });
    } catch (error) {
      throw engineFailure(error, NOT_PAINTED);
    }
    // Painting takes seconds. The character may have been deleted in that
    // time, or given another picture, which is newer than the one asked for
    // here and must not be lost to it.
    const { id } = existing(c);
    if (characters.imageFile(id) !== before) {
      throw new ApiError(
        409,
        'The picture was changed while a new one was being made, so the new one was not kept.',
      );
    }
    return c.json(setPicture(id, media.save('images', 'png', picture)));
  });

  // Use a picture of the user's own. The body is the image file itself.
  routes.put(
    '/:id/image',
    bodyLimit({
      maxSize: MAX_PICTURE_BYTES,
      onError: () => {
        throw new ApiError(413, 'That picture is too large to use.');
      },
    }),
    async (c) => {
      existing(c);
      const picture = new Uint8Array(await c.req.arrayBuffer());
      // Looked up again: the character may have been deleted while the file
      // was arriving, and a file saved for it then would never be removed.
      const { id } = existing(c);
      const kind = pictureKind(picture);
      if (kind === undefined) {
        throw new ApiError(400, 'A picture must be a PNG, JPEG or WebP image.');
      }
      return c.json(setPicture(id, media.save('images', kind, picture)));
    },
  );

  // The picture. An address with a version (`?v=`, as `imageUrl` has) only
  // ever serves that picture, so a browser may keep it for good; one that
  // has been replaced is gone.
  routes.get('/:id/image', (c) => {
    const file = characters.imageFile(existing(c).id);
    const version = c.req.query('v');
    const picture =
      file === undefined ||
      (version !== undefined && version !== path.parse(file).name)
        ? undefined
        : media.read(file);
    if (file === undefined || picture === undefined) {
      throw new ApiError(404, 'That character has no such picture.');
    }
    return c.body(picture, 200, {
      'Content-Type':
        PICTURE_TYPES[path.extname(file).slice(1)] ??
        'application/octet-stream',
      'Cache-Control':
        version === undefined
          ? 'no-cache'
          : 'private, max-age=31536000, immutable',
    });
  });

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
      existing(c);
      const clip = new Uint8Array(await c.req.arrayBuffer());
      // Looked up again, for the same reason as a picture's upload.
      const { id } = existing(c);
      checkVoiceClip(clip);
      return c.json(setVoice(id, media.save('voices', 'wav', clip)));
    },
  );

  // Back to the engine's built-in voice.
  routes.delete('/:id/voice', (c) => c.json(setVoice(existing(c).id, null)));

  // Have the character's voice ready before it first speaks. Asked for when
  // a chat opens; it answers at once and the engine does the work after.
  routes.post('/:id/voice/warm', (c) => {
    const voice = characters.voiceFile(existing(c).id);
    if (voice !== undefined) warmer.warm(media.path(voice));
    return c.body(null, 204);
  });

  return routes;
}
