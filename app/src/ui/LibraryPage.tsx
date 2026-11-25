import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

/** One character, scenario or player, as the list shows it. */
interface Item {
  id: string;
  name: string;
  excerpt: string;
  chatCount: number;
  /** The address of a picture to show beside it, if it has one. */
  imageUrl?: string | null;
}

/** What differs between the lists of characters, scenarios and players. */
interface Kind {
  heading: string;
  noun: string;
  /** Where this kind's pages live, such as `/characters`. */
  route: string;
  /** The new-chat page's query parameter that preselects one of these. */
  chatParameter: string;
  chatLabel: (name: string) => string;
  /**
   * How a chat relates to one of these: "with Mara", "set in The Storm" or
   * "played as Bob".
   */
  chatsOf: (name: string) => string;
  list: () => Promise<Item[]>;
  remove: (id: string) => Promise<undefined>;
}

export const CHARACTERS: Kind = {
  heading: 'Characters',
  noun: 'character',
  route: '/characters',
  chatParameter: 'character',
  chatLabel: (name) => `Chat with ${name}`,
  chatsOf: (name) => `with ${name}`,
  list: async () =>
    (await api.listCharacters()).map(
      ({ id, name, persona, chatCount, imageUrl }) => ({
        id,
        name,
        excerpt: persona,
        chatCount,
        imageUrl,
      }),
    ),
  remove: api.deleteCharacter,
};

export const SCENARIOS: Kind = {
  heading: 'Scenarios',
  noun: 'scenario',
  route: '/scenarios',
  chatParameter: 'scenario',
  chatLabel: (name) => `Start a chat in ${name}`,
  chatsOf: (name) => `set in ${name}`,
  list: async () =>
    (await api.listScenarios()).map(({ id, title, premise, chatCount }) => ({
      id,
      name: title,
      excerpt: premise,
      chatCount,
    })),
  remove: api.deleteScenario,
};

export const PLAYERS: Kind = {
  heading: 'Players',
  noun: 'player',
  route: '/players',
  chatParameter: 'player',
  chatLabel: (name) => `Start a chat as ${name}`,
  chatsOf: (name) => `played as ${name}`,
  list: async () =>
    (await api.listPlayers()).map(({ id, name, background, chatCount }) => ({
      id,
      name,
      excerpt: background,
      chatCount,
    })),
  remove: api.deletePlayer,
};

function chats(count: number): string {
  return count === 1 ? '1 chat' : `${String(count)} chats`;
}

/** The user's characters, scenarios or players, with ways to chat, edit and delete. */
export function LibraryPage({ kind }: { kind: Kind }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The item the user has asked to delete, until they answer. */
  const [deleting, setDeleting] = useState<Item | null>(null);

  const fail = (reason: unknown): void => {
    setError(errorMessage(reason));
  };

  useEffect(() => {
    let current = true;
    kind.list().then((loaded) => {
      if (current) setItems(loaded);
    }, fail);
    return () => {
      current = false;
    };
  }, [kind]);

  const confirmDelete = (item: Item): void => {
    setDeleting(null);
    kind
      .remove(item.id)
      .then(() => kind.list())
      .then(setItems, fail);
  };

  return (
    <div className="page">
      <header className="page-header with-action">
        <h1>{kind.heading}</h1>
        <a className="button primary" href={`#${kind.route}/new`}>
          New {kind.noun}
        </a>
      </header>

      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {items === null && error === null && <p>Loading…</p>}
      {items?.length === 0 && (
        <p className="hint">There are no {kind.noun}s yet. A chat needs one.</p>
      )}

      <ul className="cards" aria-label={kind.heading}>
        {items?.map((item) => (
          <li key={item.id} className="card">
            {typeof item.imageUrl === 'string' && (
              <img
                className="card-picture"
                src={item.imageUrl}
                alt={`Picture of ${item.name}`}
              />
            )}
            <div className="card-text">
              <h2>{item.name}</h2>
              <p className="hint">{chats(item.chatCount)}</p>
              <p className="card-excerpt">{item.excerpt}</p>
            </div>
            <div className="card-actions">
              <a
                className="button"
                href={`#/chats/new?${kind.chatParameter}=${item.id}`}
                aria-label={kind.chatLabel(item.name)}
              >
                Chat
              </a>
              <a
                className="button"
                href={`#${kind.route}/${item.id}`}
                aria-label={`Edit ${item.name}`}
              >
                Edit
              </a>
              <button
                type="button"
                aria-label={`Delete ${item.name}`}
                onClick={() => {
                  setDeleting(item);
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
          confirmLabel={`Delete ${kind.noun}`}
          onConfirm={() => {
            confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        >
          <p>
            {deleting.chatCount > 0
              ? `This also deletes the ${chats(deleting.chatCount)} ${kind.chatsOf(deleting.name)}, including every message in them.`
              : `${deleting.name} has no chats.`}{' '}
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
