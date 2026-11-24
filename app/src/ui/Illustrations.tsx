import { useEffect, useRef, useState } from 'react';
import type { Illustration, IllustrationProgress } from '../shared/api.ts';

const PROGRESS: Record<
  Exclude<IllustrationProgress['state'], 'failed'>,
  string
> = {
  describing: 'Describing the scene…',
  waiting: 'Waiting for the engine…',
  'painting-location': 'Painting the location…',
  painting: 'Painting the scene…',
};

/** A picture shown at full size, over the page. Escape or Close ends it. */
function FullSize({
  picture,
  onClose,
}: {
  picture: { src: string; alt: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog picture-dialog"
      aria-label={picture.alt}
      onCancel={onClose}
    >
      <img src={picture.src} alt={picture.alt} />
      <div className="form-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/**
 * The pictures of one of the character's messages, how far a new one has
 * got, and the button that asks for one.
 */
export function MessageIllustrations({
  characterName,
  characterId,
  hasPicture,
  illustrations,
  progress,
  onIllustrate,
}: {
  characterName: string;
  characterId: string;
  /** Whether the character has the reference picture illustrations need. */
  hasPicture: boolean;
  illustrations: Illustration[];
  progress: IllustrationProgress | undefined;
  onIllustrate: () => void;
}) {
  const [open, setOpen] = useState<Illustration | null>(null);
  /** Shown when Illustrate is chosen for a character without a picture. */
  const [needsPicture, setNeedsPicture] = useState(false);
  const working =
    progress === undefined || progress.state === 'failed'
      ? undefined
      : progress.state;

  return (
    <div className="illustrations">
      {illustrations.map((illustration, index) => (
        <button
          key={illustration.id}
          type="button"
          className="illustration"
          aria-label={`Open illustration ${String(index + 1)} at full size`}
          onClick={() => {
            setOpen(illustration);
          }}
        >
          <img
            src={illustration.imageUrl}
            alt={`Illustration ${String(index + 1)} of this moment`}
          />
        </button>
      ))}
      {working !== undefined && (
        <p className="illustration-progress" role="status">
          {PROGRESS[working]}
        </p>
      )}
      {progress?.state === 'failed' && (
        <p className="illustration-error" role="alert">
          {progress.error ?? 'The picture could not be made.'}{' '}
          <button type="button" onClick={onIllustrate}>
            Try again
          </button>
        </p>
      )}
      {needsPicture && !hasPicture && (
        <p className="illustration-error" role="alert">
          Illustrating needs a reference picture of {characterName}.{' '}
          <a href={`#/characters/${characterId}`}>
            Give {characterName} a picture
          </a>
        </p>
      )}
      {progress === undefined && (
        <button
          type="button"
          className="illustrate"
          onClick={() => {
            if (hasPicture) onIllustrate();
            else setNeedsPicture(true);
          }}
        >
          Illustrate
        </button>
      )}
      {open !== null && (
        <FullSize
          picture={{
            src: open.imageUrl,
            alt: `Illustration ${String(illustrations.indexOf(open) + 1)} of this moment, at full size`,
          }}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
