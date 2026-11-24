import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { MIN_VOICE_SECONDS } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { playClip } from './speech/playClip.ts';
import { MAX_VOICE_SECONDS, voiceClip } from './speech/recording.ts';

/**
 * A character's voice: upload a clip to clone it from, replace it, remove
 * it, and hear a sample. Each change is saved as it is made.
 */
export function CharacterVoice({
  characterId,
  name,
  hasVoice,
  onChange,
}: {
  characterId: string;
  /** The character's name as the editor has it now, for the sample line. */
  name: string;
  hasVoice: boolean;
  /** Called when the character has been given a clip, or has lost it. */
  onChange: (hasVoice: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ends the sample being played, while one is. */
  const [preview, setPreview] = useState<AbortController | null>(null);
  const playing = useRef<AbortController | null>(null);
  const id = useId();

  // Leaving the editor ends the sample.
  useEffect(
    () => () => {
      playing.current?.abort();
    },
    [],
  );

  const change = (work: () => Promise<{ hasVoice: boolean }>): void => {
    setError(null);
    setBusy(true);
    work()
      .then(
        (character) => {
          onChange(character.hasVoice);
        },
        (reason: unknown) => {
          setError(errorMessage(reason));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared, so that choosing the same file again is still a change.
    event.target.value = '';
    if (file === undefined) return;
    change(async () => api.setVoice(characterId, await voiceClip(file)));
  };

  const play = (): void => {
    const control = new AbortController();
    playing.current = control;
    setPreview(control);
    setError(null);
    const who = name.trim() === '' ? '' : ` I am ${name.trim()}.`;
    api
      .speak(
        { text: `Hello.${who} This is how I sound.`, characterId },
        control.signal,
      )
      .then((clip) => playClip(clip, control.signal))
      .catch((reason: unknown) => {
        if (!control.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        setPreview((now) => (now === control ? null : now));
      });
  };

  return (
    <fieldset className="media">
      <legend>Voice</legend>
      <p role="status">
        {hasVoice
          ? 'Replies are spoken in the voice cloned from the clip you gave.'
          : 'No voice clip. Replies are spoken in the built-in voice.'}
      </p>
      <label htmlFor={id}>Voice clip</label>
      <input
        id={id}
        type="file"
        accept="audio/*"
        disabled={busy}
        aria-describedby={`${id}-hint`}
        onChange={upload}
      />
      <p className="hint" id={`${id}-hint`}>
        A recording of one person speaking clearly, longer than{' '}
        {MIN_VOICE_SECONDS} seconds. The first {MAX_VOICE_SECONDS} seconds are
        kept. It is saved as soon as it is chosen, and stays on this computer.
      </p>
      <div className="form-actions">
        {preview === null ? (
          <button type="button" disabled={busy} onClick={play}>
            Preview voice
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              preview.abort();
              setPreview(null);
            }}
          >
            Stop preview
          </button>
        )}
        {hasVoice && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              change(() => api.removeVoice(characterId));
            }}
          >
            Remove voice clip
          </button>
        )}
      </div>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
