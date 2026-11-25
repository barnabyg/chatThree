import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { MIN_VOICE_SECONDS } from '../shared/api.ts';
import { voiceClipProblem } from '../shared/voiceClip.ts';
import { api, errorMessage } from './api.ts';
import { playClip } from './speech/playClip.ts';
import { MAX_VOICE_SECONDS, voiceClip } from './speech/recording.ts';

/** A clip chosen for a character that has not been saved yet. */
export type PendingClip = Uint8Array<ArrayBuffer>;

/**
 * A character's voice: upload a clip to clone it from, replace it, remove
 * it, and hear a sample. For a saved character each change is saved as it
 * is made. For a new one (no `characterId`) the clip is held, as `pending`,
 * until the character is saved.
 */
export function CharacterVoice({
  characterId,
  name,
  hasVoice,
  onChange,
  pending = null,
  onPending,
}: {
  characterId?: string;
  /** The character's name as the editor has it now, for the sample line. */
  name: string;
  hasVoice: boolean;
  /** Called when the character has been given a clip, or has lost it. */
  onChange: (hasVoice: boolean) => void;
  /** The clip held for a new character, if one has been chosen. */
  pending?: PendingClip | null;
  /** Called when a new character's clip is chosen or removed. */
  onPending?: (clip: PendingClip | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ends the sample being played, while one is. */
  const [preview, setPreview] = useState<AbortController | null>(null);
  const playing = useRef<AbortController | null>(null);
  const id = useId();
  const saved = characterId !== undefined;
  const voiced = saved ? hasVoice : pending !== null;

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

  /** Read a new character's clip and hold it, if a voice can be cloned from it. */
  const hold = async (file: File): Promise<{ hasVoice: boolean }> => {
    const clip = await voiceClip(file);
    const problem = voiceClipProblem(clip);
    if (problem !== undefined) throw new Error(problem);
    onPending?.(clip);
    return { hasVoice: false };
  };

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared, so that choosing the same file again is still a change.
    event.target.value = '';
    if (file === undefined) return;
    change(async () =>
      characterId === undefined
        ? hold(file)
        : api.setVoice(characterId, await voiceClip(file)),
    );
  };

  const remove = (): void => {
    if (characterId === undefined) {
      setError(null);
      onPending?.(null);
      return;
    }
    change(() => api.removeVoice(characterId));
  };

  const play = (): void => {
    const control = new AbortController();
    playing.current = control;
    setPreview(control);
    setError(null);
    const who = name.trim() === '' ? '' : ` I am ${name.trim()}.`;
    api
      .speak(
        {
          text: `Hello.${who} This is how I sound.`,
          ...(characterId !== undefined && { characterId }),
        },
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

  /** The cloned voice can only be heard once its clip is saved. */
  const canPreview = saved || pending === null;

  return (
    <fieldset className="media">
      <legend>Voice</legend>
      <p role="status">
        {!voiced
          ? 'No voice clip. Replies are spoken in the built-in voice.'
          : saved
            ? 'Replies are spoken in the voice cloned from the clip you gave.'
            : 'Replies will be spoken in the voice cloned from the clip you gave. It is saved with the character.'}
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
        kept.{' '}
        {saved
          ? 'It is saved as soon as it is chosen, and stays on this computer.'
          : 'It is saved with the character, and stays on this computer.'}
      </p>
      <div className="form-actions">
        {preview === null ? (
          <button type="button" disabled={busy || !canPreview} onClick={play}>
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
        {voiced && (
          <button type="button" disabled={busy} onClick={remove}>
            Remove voice clip
          </button>
        )}
      </div>
      {!canPreview && (
        <p className="hint">Save the character to preview the cloned voice.</p>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
