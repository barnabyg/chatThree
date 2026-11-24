import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_SPEECH_CHARACTERS } from '../../shared/api.ts';
import {
  EngineFailedError,
  type EngineJobs,
  EngineRefusedError,
  EngineUnavailableError,
} from '../engine/jobs.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { MediaStore } from '../store/media.ts';
import { ApiError, readBody } from './errors.ts';

const speechRequest = z.strictObject({
  text: z
    .string('There is no text to speak.')
    .trim()
    .min(1, 'There is no text to speak.')
    .max(
      MAX_SPEECH_CHARACTERS,
      `At most ${String(MAX_SPEECH_CHARACTERS)} characters can be spoken at a time.`,
    ),
  characterId: z.string('That character does not exist.').optional(),
});

/** Why a clip could not be made, as an API failure with words for the user. */
function unavailable(error: unknown): unknown {
  if (error instanceof EngineUnavailableError) {
    return new ApiError(
      503,
      'Speech is unavailable because the engine is not ready.',
    );
  }
  if (error instanceof EngineRefusedError) {
    return new ApiError(400, `Speech is unavailable: ${error.message}`);
  }
  if (error instanceof EngineFailedError) {
    return new ApiError(
      502,
      'Speech is unavailable: the engine could not speak that.',
    );
  }
  return error;
}

export function speechRoutes(
  jobs: EngineJobs,
  characters: CharacterStore,
  media: MediaStore,
): Hono {
  const routes = new Hono();

  /** The path of the character's voice clip, if it has one. */
  const voiceOf = (characterId: string): string | undefined => {
    if (characters.find(characterId) === undefined) {
      throw new ApiError(404, 'That character does not exist.');
    }
    const file = characters.voiceFile(characterId);
    return file === undefined ? undefined : media.path(file);
  };

  // Speak one sentence, in a character's voice if one is named. The answer
  // is the clip, whole.
  routes.post('/', async (c) => {
    const { text, characterId } = await readBody(c, speechRequest);
    const voice = characterId === undefined ? undefined : voiceOf(characterId);
    try {
      const clip = await jobs.speak(text, {
        ...(voice !== undefined && { voice }),
        // The browser gives up on clips it no longer wants, and so does the job.
        signal: c.req.raw.signal,
      });
      return c.body(clip, 200, { 'Content-Type': 'audio/wav' });
    } catch (error) {
      throw unavailable(error);
    }
  });

  return routes;
}
