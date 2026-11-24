import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_SPEECH_CHARACTERS } from '../../shared/api.ts';
import type { EngineJobs } from '../engine/jobs.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { MediaStore } from '../store/media.ts';
import { engineFailure, type EngineFailureWords } from './engineFailures.ts';
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

const NOT_SPOKEN: EngineFailureWords = {
  unavailable: 'Speech is unavailable because the engine is not ready.',
  refused: (reason) => `Speech is unavailable: ${reason}`,
  failed: 'Speech is unavailable: the engine could not speak that.',
};

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
      throw engineFailure(error, NOT_SPOKEN);
    }
  });

  return routes;
}
