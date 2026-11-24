// Preparing voices ahead of the first sentence spoken in them.
//
// The engine clones a voice the first time it speaks in it, which takes a
// few seconds. Asked for when a chat opens, that wait is over before the
// first reply arrives.

import { type EngineJobs, EngineUnavailableError } from './jobs.ts';
import type { EngineControl } from './supervisor.ts';

export class VoiceWarmer {
  readonly #engine: EngineControl;
  readonly #jobs: EngineJobs;
  /** Clips to prepare when the engine is next ready. */
  readonly #waiting = new Set<string>();
  /**
   * The clip last asked for: most likely the voice of the chat that is
   * open. An engine that restarts has forgotten it.
   */
  #latest: string | undefined;

  constructor(engine: EngineControl, jobs: EngineJobs) {
    this.#engine = engine;
    this.#jobs = jobs;
    engine.subscribe((status) => {
      if (status.state !== 'ready') return;
      const clips = new Set(this.#waiting);
      if (this.#latest !== undefined) clips.add(this.#latest);
      this.#waiting.clear();
      for (const clip of clips) this.#prepare(clip);
    });
  }

  /**
   * Have the voice in the clip at `clip` prepared: now, or as soon as the
   * engine is ready. Returns at once. A voice that cannot be prepared is
   * found out when a sentence is spoken in it, so a failure here is only
   * logged.
   */
  warm(clip: string): void {
    this.#latest = clip;
    if (this.#engine.status().state === 'ready') this.#prepare(clip);
    else this.#waiting.add(clip);
  }

  #prepare(clip: string): void {
    this.#jobs.prepareVoice(clip).catch((error: unknown) => {
      if (error instanceof EngineUnavailableError) {
        // The engine went away between reporting ready and being asked, as
        // at the start of a restart. It is asked again when it is back.
        this.#waiting.add(clip);
        return;
      }
      console.warn(
        `The voice in ${clip} could not be prepared ahead of time: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
