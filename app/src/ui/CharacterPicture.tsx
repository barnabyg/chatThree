import { type ChangeEvent, useId, useState } from 'react';
import type { Character } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';

/**
 * A character's reference picture: have the engine make one from the
 * appearance, make another, or upload one. Each change is saved as it is made.
 */
export function CharacterPicture({
  characterId,
  name,
  appearance,
  imageUrl,
  onChange,
}: {
  characterId: string;
  name: string;
  /** The appearance as the editor has it now, saved or not. */
  appearance: string;
  imageUrl: string | null;
  /** Called with the new picture's address when the picture has changed. */
  onChange: (imageUrl: string | null) => void;
}) {
  /** What is being done to the picture, while something is. */
  const [working, setWorking] = useState<'generating' | 'uploading' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const change = (
    kind: 'generating' | 'uploading',
    work: Promise<Character>,
  ): void => {
    setError(null);
    setWorking(kind);
    work
      .then(
        (character) => {
          onChange(character.imageUrl);
        },
        (reason: unknown) => {
          setError(errorMessage(reason));
        },
      )
      .finally(() => {
        setWorking(null);
      });
  };

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared, so that choosing the same file again is still a change.
    event.target.value = '';
    if (file !== undefined) {
      change('uploading', api.setPicture(characterId, file));
    }
  };

  return (
    <fieldset className="media">
      <legend>Picture</legend>
      {imageUrl === null ? (
        <p role="status">No picture yet.</p>
      ) : (
        <img
          className="reference-picture"
          src={imageUrl}
          alt={`Reference picture of ${name.trim() === '' ? 'the character' : name.trim()}`}
        />
      )}
      <p className="hint">
        The reference picture keeps the character looking the same from scene to
        scene. It is made from the appearance above as it reads now, and is
        saved as soon as it is made.
      </p>
      <div className="form-actions">
        <button
          type="button"
          disabled={working !== null}
          onClick={() => {
            change('generating', api.generatePicture(characterId, appearance));
          }}
        >
          {imageUrl === null ? 'Generate picture' : 'Generate another'}
        </button>
      </div>
      <label htmlFor={id}>Upload a picture</label>
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={working !== null}
        aria-describedby={`${id}-hint`}
        onChange={upload}
      />
      <p className="hint" id={`${id}-hint`}>
        A PNG, JPEG or WebP image of your own, in place of a generated one.
      </p>
      {working === 'generating' && <p role="status">Making the picture…</p>}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
