import { type SyntheticEvent, useEffect, useState } from 'react';
import type { PlayerInput } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';
import { TextField } from './TextField.tsx';

const BLANK: PlayerInput = { name: '', background: '' };

/** Create a player, or edit the one with `id`. */
export function PlayerEditor({ id }: { id?: string }) {
  const [player, setPlayer] = useState<PlayerInput | null>(
    id === undefined ? BLANK : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let current = true;
    api.getPlayer(id).then(
      ({ name, background }) => {
        if (current) setPlayer({ name, background });
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  if (player === null) {
    return (
      <div className="page">
        {error === null ? <p>Loading…</p> : <p role="alert">{error}</p>}
      </div>
    );
  }

  const save = (event: SyntheticEvent): void => {
    event.preventDefault();
    setError(null);
    const saved =
      id === undefined
        ? api.createPlayer(player)
        : api.updatePlayer(id, player);
    saved.then(
      () => {
        navigate('/players');
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{id === undefined ? 'New player' : 'Edit player'}</h1>
        <p>Someone you can play in any scenario.</p>
      </header>
      <form className="form" onSubmit={save}>
        <TextField
          label="Name"
          required
          maxLength={100}
          value={player.name}
          onChange={(name) => {
            setPlayer({ ...player, name });
          }}
        />
        <TextField
          label="Background"
          hint="Who they are: history, personality, what they want. The character knows what the story would let them know."
          rows={6}
          value={player.background}
          onChange={(background) => {
            setPlayer({ ...player, background });
          }}
        />
        <div className="form-actions">
          <button type="submit" className="primary">
            Save player
          </button>
          <a className="button" href="#/players">
            Cancel
          </a>
        </div>
        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
