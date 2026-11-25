import { type SyntheticEvent, useEffect, useState } from 'react';
import type { ReplyPromptInput } from '../shared/api.ts';
import {
  CHARACTER_PLACEHOLDER,
  DEFAULT_REPLY_PROMPT,
  USER_PLACEHOLDER,
} from '../shared/replyPrompt.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';
import { TextField } from './TextField.tsx';

/** A new reply prompt starts from the default, to be changed. */
const BLANK: ReplyPromptInput = { name: '', prompt: DEFAULT_REPLY_PROMPT };

/** Create a reply prompt, or edit the one with `id`. */
export function ReplyPromptEditor({ id }: { id?: string }) {
  const [replyPrompt, setReplyPrompt] = useState<ReplyPromptInput | null>(
    id === undefined ? BLANK : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let current = true;
    api.getReplyPrompt(id).then(
      ({ name, prompt }) => {
        if (current) setReplyPrompt({ name, prompt });
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  if (replyPrompt === null) {
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
        ? api.createReplyPrompt(replyPrompt)
        : api.updateReplyPrompt(id, replyPrompt);
    saved.then(
      () => {
        navigate('/settings/reply-prompts');
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{id === undefined ? 'New reply prompt' : 'Edit reply prompt'}</h1>
        <p>
          How the character is told to reply: the last part of a chat&apos;s
          instructions, chosen when the chat starts.
        </p>
      </header>
      <form className="form" onSubmit={save}>
        <TextField
          label="Name"
          required
          maxLength={100}
          value={replyPrompt.name}
          onChange={(name) => {
            setReplyPrompt({ ...replyPrompt, name });
          }}
        />
        <TextField
          label="Prompt"
          hint={`${CHARACTER_PLACEHOLDER} is replaced by the character's name, and ${USER_PLACEHOLDER} by the player's, or "the user" in a chat with no player. Changes apply to the chats that use it from their next reply.`}
          rows={8}
          required
          value={replyPrompt.prompt}
          onChange={(prompt) => {
            setReplyPrompt({ ...replyPrompt, prompt });
          }}
        />
        <div className="form-actions">
          <button type="submit" className="primary">
            Save reply prompt
          </button>
          <a className="button" href="#/settings/reply-prompts">
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
