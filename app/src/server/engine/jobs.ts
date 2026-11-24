// The jobs the app sends to the engine over its loopback HTTP API.

import type { EngineControl } from './supervisor.ts';

const SPEECH_TIMEOUT_MS = 60_000;

/** The engine cannot take jobs: it is loading, has failed, or has gone. */
export class EngineUnavailableError extends Error {
  constructor() {
    super('The engine is not ready.');
  }
}

/** The engine refused a job. The message is the engine's own reason. */
export class EngineRefusedError extends Error {}

/** The engine took a job and could not finish it. */
export class EngineFailedError extends Error {}

export interface SpeakOptions {
  /** Ends the job early, for a listener who has gone away. */
  signal?: AbortSignal;
}

export interface EngineJobs {
  /** Speak `text`. Resolves to the clip, as a WAV file. */
  speak(text: string, options?: SpeakOptions): Promise<Uint8Array<ArrayBuffer>>;
}

/** The engine's reason for refusing a request, from FastAPI's error body. */
async function refusal(response: Response): Promise<string> {
  try {
    const { detail } = (await response.json()) as { detail?: unknown };
    if (typeof detail === 'string') return detail;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `The engine refused the request (${String(response.status)}).`;
}

export function engineJobs(engine: Pick<EngineControl, 'url'>): EngineJobs {
  /** Send one job and return the engine's successful answer. */
  const post = async (
    path: string,
    body: object,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const url = engine.url();
    if (url === undefined) throw new EngineUnavailableError();
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal:
          signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.aborted) {
        throw new EngineFailedError('The engine took too long to answer.');
      }
      // Nothing is listening: the engine has gone since it reported ready.
      throw new EngineUnavailableError();
    }
    if (response.ok) return response;
    if (response.status === 503) throw new EngineUnavailableError();
    if (response.status >= 400 && response.status < 500) {
      throw new EngineRefusedError(await refusal(response));
    }
    throw new EngineFailedError(
      `The engine failed (${String(response.status)}).`,
    );
  };

  return {
    async speak(text, options = {}) {
      const response = await post(
        '/speech',
        { text },
        SPEECH_TIMEOUT_MS,
        options.signal,
      );
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
