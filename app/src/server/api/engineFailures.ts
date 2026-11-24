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

/**
 * The API failure to throw for a job the engine did not do, in the words
 * given. Anything that is not the engine's doing is returned as it is.
 */
export function engineFailure(
  error: unknown,
  words: EngineFailureWords,
): unknown {
  if (error instanceof EngineUnavailableError) {
    return new ApiError(503, words.unavailable);
  }
  if (error instanceof EngineRefusedError) {
    return new ApiError(400, words.refused(error.message));
  }
  if (error instanceof EngineFailedError) {
    return new ApiError(502, words.failed);
  }
  return error;
}
