import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';

/** The front page: the most recent chat, or the way to start the first one. */
export function Home() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.listChats().then(
      ([latest]) => {
        if (!current) return;
        navigate(latest === undefined ? '/chats/new' : `/chats/${latest.id}`, {
          replace: true,
        });
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return error === null ? (
    <p className="page">Loading…</p>
  ) : (
    <p className="page" role="alert">
      {error}
    </p>
  );
}
