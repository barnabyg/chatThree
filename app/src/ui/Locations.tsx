import { useState } from 'react';
import type { Chat, Location } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';

/**
 * The places a chat's story has been, each with its reference picture, and
 * a way to paint that picture again.
 */
export function Locations({
  chatId,
  current,
  locations,
  onChange,
}: {
  chatId: string;
  current: Location;
  locations: Location[];
  /** Called with the chat once a place's picture has changed. */
  onChange: (chat: Chat) => void;
}) {
  /** The place whose picture is being painted, while one is. */
  const [painting, setPainting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const repaint = (location: Location): void => {
    setError(null);
    setPainting(location.id);
    api
      .repaintLocation(chatId, location.id)
      .then(onChange, (reason: unknown) => {
        setError(errorMessage(reason));
      })
      .finally(() => {
        setPainting(null);
      });
  };

  return (
    <details className="locations">
      <summary>Locations ({locations.length})</summary>
      <ul aria-label="Locations">
        {locations.map((location) => (
          <li key={location.id} className="location">
            <h3>
              {location.name}
              {location.id === current.id && (
                <span className="location-current"> (here now)</span>
              )}
            </h3>
            {location.imageUrl === null ? (
              <p className="hint">No picture yet.</p>
            ) : (
              <img
                className="location-picture"
                src={location.imageUrl}
                alt={`Reference picture of ${location.name}`}
              />
            )}
            {location.description !== '' && (
              <p className="hint">{location.description}</p>
            )}
            <button
              type="button"
              disabled={painting !== null}
              onClick={() => {
                repaint(location);
              }}
            >
              {location.imageUrl === null
                ? 'Generate picture'
                : 'Generate another'}
            </button>
            {painting === location.id && (
              <p role="status">Painting the location…</p>
            )}
          </li>
        ))}
      </ul>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
