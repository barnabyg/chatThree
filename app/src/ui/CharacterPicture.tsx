import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { pictureProblem } from '../shared/picture.ts';
import { api, errorMessage } from './api.ts';

/**
 * A picture chosen for a character that has not been saved yet, with an
 * address to show it by until then.
 */
export interface PendingPicture {
  file: Blob;
  url: string;
}

/**
 * A character's reference picture: have the engine make one from the
 * appearance, make another, or upload one. For a saved character each change
 * is saved as it is made. For a new one (no `characterId`) only an upload is
 * offered, and the picture is held, as `pending`, until the character is
 * saved.
 */
export function CharacterPicture({
  characterId,
  name,
  appearance,
  imageUrl,
  onChange,
  pending = null,
  onPending,
}: {
  characterId?: string;
  name: string;
  /** The appearance as the editor has it now, saved or not. */
  appearance: string;
  imageUrl: string | null;
  /** Called with the new picture's address when the picture has changed. */
  onChange: (imageUrl: string | null) => void;
  /** The picture held for a new character, if one has been chosen. */
  pending?: PendingPicture | null;
  /** Called when a new character's picture is chosen or removed. */
  onPending?: (picture: PendingPicture | null) => void;
}) {
  /** What is being done to the picture, while something is. */
  const [working, setWorking] = useState<'generating' | 'uploading' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const saved = characterId !== undefined;

  // Leaving the editor lets go of the held picture.
  const held = useRef(pending);
  useEffect(() => {
    held.current = pending;
  }, [pending]);
  useEffect(
    () => () => {
      if (held.current !== null) URL.revokeObjectURL(held.current.url);
    },
    [],
  );

  /** Hold `file` for a new character in place of any held before, or none. */
  const replacePending = (file: Blob | null): void => {
    if (pending !== null) URL.revokeObjectURL(pending.url);
    onPending?.(
      file === null ? null : { file, url: URL.createObjectURL(file) },
    );
  };

  const change = (
    kind: 'generating' | 'uploading',
    work: Promise<{ imageUrl: string | null }>,
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

  /** Check a new character's picture and hold it, if it can be used. */
  const hold = async (file: File): Promise<{ imageUrl: string | null }> => {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const problem = pictureProblem(file.size, head);
    if (problem !== undefined) throw new Error(problem);
    replacePending(file);
    return { imageUrl: null };
  };

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Cleared, so that choosing the same file again is still a change.
    event.target.value = '';
    if (file === undefined) return;
    change(
      'uploading',
      characterId === undefined
        ? hold(file)
        : api.setPicture(characterId, file),
    );
  };

  const shownUrl = saved ? imageUrl : (pending?.url ?? null);

  return (
    <fieldset className="media">
      <legend>Picture</legend>
      {shownUrl === null ? (
        <p role="status">No picture yet.</p>
      ) : (
        <img
          className="reference-picture"
          src={shownUrl}
          alt={`Reference picture of ${name.trim() === '' ? 'the character' : name.trim()}`}
        />
      )}
      {characterId !== undefined ? (
        <>
          <p className="hint">
            The reference picture keeps the character looking the same from
            scene to scene. It is made from the appearance above as it reads
            now, and is saved as soon as it is made.
          </p>
          <div className="form-actions">
            <button
              type="button"
              disabled={working !== null}
              onClick={() => {
                change(
                  'generating',
                  api.generatePicture(characterId, appearance),
                );
              }}
            >
              {imageUrl === null ? 'Generate picture' : 'Generate another'}
            </button>
          </div>
        </>
      ) : (
        <p className="hint">
          The reference picture keeps the character looking the same from scene
          to scene. An uploaded picture is saved with the character; to have one
          made from the appearance, save the character, then edit it.
        </p>
      )}
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
      {!saved && pending !== null && (
        <div className="form-actions">
          <button
            type="button"
            disabled={working !== null}
            onClick={() => {
              setError(null);
              replacePending(null);
            }}
          >
            Remove picture
          </button>
        </div>
      )}
      {working === 'generating' && <p role="status">Making the picture…</p>}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
