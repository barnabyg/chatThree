// The order of speaking: sentences go in as a reply arrives, and come out as
// sound, one after another. Clips are made ahead of playback, one at a
// time and in order, so that the next is usually ready when one ends.

export interface SpeechQueueOptions<Clip> {
  /** Make the clip for one sentence. `signal` aborts when it is no longer wanted. */
  synthesise(text: string, signal: AbortSignal): Promise<Clip>;
  /** Play one clip to its end, or until `signal` aborts. */
  play(clip: Clip, signal: AbortSignal): Promise<void>;
  /** Called when speaking starts, and when nothing is left to speak. */
  onSpeakingChange(speaking: boolean): void;
  /**
   * Called when a sentence cannot be spoken, with the reason. Everything
   * still waiting to be spoken is dropped.
   */
  onFailure(message: string): void;
}

export interface SpeechQueue {
  /** Speak this sentence after everything said before it. */
  say(text: string): void;
  /** Halt what is playing and drop everything not yet played. */
  stop(): void;
}

export function speechQueue<Clip>(
  options: SpeechQueueOptions<Clip>,
): SpeechQueue {
  /** Aborts everything said since the last stop. */
  let current = new AbortController();
  /** Settles when the last clip asked for has been made. */
  let made: Promise<unknown> = Promise.resolve();
  /** Settles when the last sentence said has been played. */
  let played: Promise<unknown> = Promise.resolve();
  /** Sentences said and not yet played. */
  let waiting = 0;

  const stop = (): void => {
    current.abort();
    current = new AbortController();
    made = Promise.resolve();
    played = Promise.resolve();
    if (waiting > 0) {
      waiting = 0;
      options.onSpeakingChange(false);
    }
  };

  return {
    say(text) {
      const { signal } = current;
      if (waiting === 0) options.onSpeakingChange(true);
      waiting += 1;
      const clip = made.then(() => {
        signal.throwIfAborted();
        return options.synthesise(text, signal);
      });
      // After a clip that cannot be made, no later one is asked for. The
      // failure is reported when that clip's turn to play comes.
      made = clip;
      clip.catch(() => undefined);
      played = played
        .then(() => clip)
        .then((ready) => {
          signal.throwIfAborted();
          return options.play(ready, signal);
        })
        .then(
          () => {
            if (signal.aborted) return;
            waiting -= 1;
            if (waiting === 0) options.onSpeakingChange(false);
          },
          (error: unknown) => {
            if (signal.aborted) return;
            options.onFailure(
              error instanceof Error ? error.message : String(error),
            );
            stop();
          },
        );
    },
    stop,
  };
}
