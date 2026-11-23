import { useEffect, useState } from 'react';
import type { Character } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { navigate } from './router.ts';

function chats(count: number): string {
  return count === 1 ? '1 chat' : `${String(count)} chats`;
}

/** Open the most recent chat with `character`, or start one. */
async function openChatWith(character: Character): Promise<void> {
  const existing = (await api.listChats()).find(
    (chat) => chat.character.id === character.id,
  );
  const chat = existing ?? (await api.createChat(character.id));
  navigate(`/chats/${chat.id}`);
}

export function CharactersPage() {
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The character the user has asked to delete, until they answer. */
  const [deleting, setDeleting] = useState<Character | null>(null);

  const fail = (reason: unknown): void => {
    setError(errorMessage(reason));
  };

  useEffect(() => {
    let current = true;
    api.listCharacters().then((loaded) => {
      if (current) setCharacters(loaded);
    }, fail);
    return () => {
      current = false;
    };
  }, []);

  const confirmDelete = (character: Character): void => {
    setDeleting(null);
    api
      .deleteCharacter(character.id)
      .then(() => api.listCharacters())
      .then(setCharacters, fail);
  };

  return (
    <div className="page">
      <header className="page-header with-action">
        <h1>Characters</h1>
        <a className="button primary" href="#/characters/new">
          New character
        </a>
      </header>

      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {characters === null && error === null && <p>Loading…</p>}
      {characters?.length === 0 && (
        <p className="hint">
          There are no characters yet. Create one to start chatting.
        </p>
      )}

      <ul className="cards" aria-label="Characters">
        {characters?.map((character) => (
          <li key={character.id} className="card">
            <div className="card-text">
              <h2>{character.name}</h2>
              <p className="hint">{chats(character.chatCount)}</p>
              <p className="card-excerpt">{character.persona}</p>
            </div>
            <div className="card-actions">
              <button
                type="button"
                aria-label={`Chat with ${character.name}`}
                onClick={() => {
                  openChatWith(character).catch(fail);
                }}
              >
                Chat
              </button>
              <a
                className="button"
                href={`#/characters/${character.id}`}
                aria-label={`Edit ${character.name}`}
              >
                Edit
              </a>
              <button
                type="button"
                aria-label={`Delete ${character.name}`}
                onClick={() => {
                  setDeleting(character);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete character"
          onConfirm={() => {
            confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        >
          <p>
            {deleting.chatCount > 0
              ? `This also deletes the ${chats(deleting.chatCount)} with ${deleting.name}, including every message in them.`
              : `${deleting.name} has no chats.`}{' '}
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
