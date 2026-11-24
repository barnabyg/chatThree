import { useEffect, useState } from 'react';
import type { ChatSummary } from '../shared/api.ts';
import { api, onDataChanged } from './api.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { navigate } from './router.ts';

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Every chat, the most recently active first, as links. `currentId` is the
 * chat on screen, if any.
 */
export function ChatList({ currentId }: { currentId: string | undefined }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  /** The chat the user has asked to delete, until they answer. */
  const [deleting, setDeleting] = useState<ChatSummary | null>(null);

  useEffect(() => {
    let current = true;
    const load = (): void => {
      api.listChats().then(
        (loaded) => {
          if (current) setChats(loaded);
        },
        // The engine status already shows when the app cannot be reached.
        () => undefined,
      );
    };
    load();
    // Chats are created, renamed, added to and deleted all over the UI.
    const stop = onDataChanged(load);
    return () => {
      current = false;
      stop();
    };
  }, []);

  const confirmDelete = (chat: ChatSummary): void => {
    setDeleting(null);
    api.deleteChat(chat.id).then(
      () => {
        if (chat.id === currentId) navigate('/');
      },
      () => undefined,
    );
  };

  return (
    <nav aria-label="Chats" className="chat-list">
      {chats.length === 0 && <p className="hint">No chats yet.</p>}
      <ul>
        {chats.map((chat) => (
          <li key={chat.id}>
            <a
              href={`#/chats/${chat.id}`}
              aria-current={chat.id === currentId ? 'page' : undefined}
            >
              <span className="chat-list-character">{chat.character.name}</span>
              <span className="chat-list-scenario">{chat.scenario.title}</span>
              <time dateTime={chat.lastActivityAt}>
                {when(chat.lastActivityAt)}
              </time>
            </a>
            <button
              type="button"
              className="chat-list-delete"
              aria-label={`Delete the chat with ${chat.character.name} in ${chat.scenario.title}`}
              onClick={() => {
                setDeleting(chat);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {deleting !== null && (
        <ConfirmDialog
          title="Delete this chat?"
          confirmLabel="Delete chat"
          onConfirm={() => {
            confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        >
          <p>
            The chat with {deleting.character.name} in {deleting.scenario.title}{' '}
            and every message in it will be deleted. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </nav>
  );
}
