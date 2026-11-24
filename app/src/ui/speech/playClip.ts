/** Play one clip to its end, or until `signal` aborts. */
export function playClip(clip: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(clip);
    const audio = new Audio(url);
    let over = false;
    const finish = (failure?: Error): void => {
      if (over) return;
      over = true;
      signal.removeEventListener('abort', halt);
      URL.revokeObjectURL(url);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const halt = (): void => {
      audio.pause();
      finish();
    };
    signal.addEventListener('abort', halt, { once: true });
    audio.addEventListener('ended', () => {
      finish();
    });
    audio.addEventListener('error', () => {
      finish(
        new Error('Speech is unavailable: the browser could not play it.'),
      );
    });
    audio.play().catch(() => {
      finish(
        new Error(
          'Speech is unavailable: the browser did not allow sound to play.',
        ),
      );
    });
  });
}
