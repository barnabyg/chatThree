import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_SPEECH_CHARACTERS } from '../../shared/api.ts';
import {
  EngineFailedError,
  type EngineJobs,
  EngineRefusedError,
  EngineUnavailableError,
} from '../engine/jobs.ts';
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

export function speechRoutes(jobs: EngineJobs): Hono {
  const routes = new Hono();

  // Speak one sentence. The answer is the clip, whole.
  routes.post('/', async (c) => {
    const { text } = await readBody(c, speechRequest);
    try {
      // The browser gives up on clips it no longer wants, and so does the job.
      const clip = await jobs.speak(text, { signal: c.req.raw.signal });
      return c.body(clip, 200, { 'Content-Type': 'audio/wav' });
    } catch (error) {
      throw unavailable(error);
    }
  });

  return routes;
}
