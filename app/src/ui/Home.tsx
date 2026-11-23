import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';

/**
 * Where the most recent chat is, starting one with the first character if
 * there are no chats. `undefined` when there is no character to chat with.
 */
async function latestChat(): Promise<string | undefined> {
  const [latest] = await api.listChats();
  if (latest !== undefined) return `/chats/${latest.id}`;
  const [character] = await api.listCharacters();
  if (character === undefined) return undefined;
  return `/chats/${(await api.createChat(character.id)).id}`;
}

/** The front page: goes straight to the most recent chat. */
export function Home() {
  const [state, setState] = useState<'loading' | 'empty' | { error: string }>(
    'loading',
  );

  useEffect(() => {
    let current = true;
    latestChat().then(
      (route) => {
        if (!current) return;
        if (route === undefined) setState('empty');
        else navigate(route, { replace: true });
      },
      (reason: unknown) => {
        if (current) setState({ error: errorMessage(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (state === 'loading') return <p className="page">Loading…</p>;
  if (state === 'empty') {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Welcome to chatThree</h1>
        </header>
        <p>
          There is no one to chat with yet.{' '}
          <a href="#/characters/new">Create a character</a> to begin.
        </p>
      </div>
    );
  }
  return (
    <p className="page" role="alert">
      {state.error}
    </p>
  );
}
