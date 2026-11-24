import {
  EngineFailedError,
  EngineRefusedError,
  EngineUnavailableError,
} from '../engine/jobs.ts';
import { ApiError } from './errors.ts';

/** What to tell the user when the engine does not do a job, by the reason. */
export interface EngineFailureWords {
  /** The engine is loading, has failed or has gone. */
  unavailable: string;
  /** The engine refused the job. `reason` is the engine's own. */
  refused: (reason: string) => string;
  /** The engine took the job and broke on it. */
  failed: string;
}

/** What to tell the user when the engine does not make a picture. */
export const NOT_PAINTED: EngineFailureWords = {
  unavailable: 'A picture cannot be made because the engine is not ready.',
  refused: (reason) => `The engine refused to make the picture: ${reason}`,
  failed: 'The engine could not make the picture.',
};

/**
 * Why the engine did not do a job, in the words given, or `undefined` if
 * the failure is not the engine's doing.
 */
export function engineFailureMessage(
  error: unknown,
  words: EngineFailureWords,
): string | undefined {
  if (error instanceof EngineUnavailableError) return words.unavailable;
  if (error instanceof EngineRefusedError) return words.refused(error.message);
  if (error instanceof EngineFailedError) return words.failed;
  return undefined;
}

/**
 * The API failure to throw for a job the engine did not do, in the words
 * given. Anything that is not the engine's doing is returned as it is.
 */
export function engineFailure(
  error: unknown,
  words: EngineFailureWords,
): unknown {
  const message = engineFailureMessage(error, words);
  if (message === undefined) return error;
  if (error instanceof EngineUnavailableError)
    return new ApiError(503, message);
  if (error instanceof EngineRefusedError) return new ApiError(400, message);
  return new ApiError(502, message);
}
