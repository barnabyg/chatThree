import { useEffect, useState } from 'react';
import type { ReplyPrompt } from '../shared/api.ts';
import { DEFAULT_REPLY_PROMPT } from '../shared/replyPrompt.ts';
import { api, errorMessage } from './api.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

function chats(count: number): string {
  return count === 1 ? '1 chat' : `${String(count)} chats`;
}

/**
 * The reply prompts a new chat can use: the default, which cannot be
 * changed, and the user's own, which can be edited and deleted.
 */
export function ReplyPrompts() {
  const [items, setItems] = useState<ReplyPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The reply prompt the user has asked to delete, until they answer. */
  const [deleting, setDeleting] = useState<ReplyPrompt | null>(null);

  const fail = (reason: unknown): void => {
    setError(errorMessage(reason));
  };

  useEffect(() => {
    let current = true;
    api.listReplyPrompts().then((loaded) => {
      if (current) setItems(loaded);
    }, fail);
    return () => {
      current = false;
    };
  }, []);

  const confirmDelete = (item: ReplyPrompt): void => {
    setDeleting(null);
    api
      .deleteReplyPrompt(item.id)
      .then(() => api.listReplyPrompts())
      .then(setItems, fail);
  };

  return (
    <section className="settings-section" aria-labelledby="reply-prompts">
      <header className="page-header with-action">
        <h2 id="reply-prompts">Reply prompts</h2>
        <a className="button" href="#/reply-prompts/new">
          New reply prompt
        </a>
      </header>
      <p className="hint">
        How the character is told to reply, at the end of a chat&apos;s
        instructions. Each chat uses the one chosen when it was started.
      </p>

      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <ul className="cards" aria-label="Reply prompts">
        <li className="card">
          <div className="card-text">
            <h3>Default</h3>
            <p className="hint">Built in</p>
            <p className="card-excerpt">{DEFAULT_REPLY_PROMPT}</p>
          </div>
        </li>
        {items?.map((item) => (
          <li key={item.id} className="card">
            <div className="card-text">
              <h3>{item.name}</h3>
              <p className="hint">{chats(item.chatCount)}</p>
              <p className="card-excerpt">{item.prompt}</p>
            </div>
            <div className="card-actions">
              <a
                className="button"
                href={`#/reply-prompts/${item.id}`}
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
          confirmLabel="Delete reply prompt"
          onConfirm={() => {
            confirmDelete(deleting);
          }}
          onCancel={() => {
            setDeleting(null);
          }}
        >
          <p>
            {deleting.chatCount > 0
              ? `The ${chats(deleting.chatCount)} using it will use the default from their next reply. Their messages are kept.`
              : 'No chats use it.'}{' '}
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
