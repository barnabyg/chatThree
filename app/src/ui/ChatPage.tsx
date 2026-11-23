import {
  Fragment,
  type SyntheticEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Chat, Message, ReplyEvent } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';

function MessageItem({
  author,
  role,
  content,
  writing = false,
}: {
  author: string;
  role: Message['role'];
  content: string;
  writing?: boolean;
}) {
  return (
    <li className={`message message-${role}`} aria-busy={writing}>
      <p className="message-author">{author}</p>
      <p className="message-content">{content}</p>
    </li>
  );
}

export function ChatPage({ chatId }: { chatId: string }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The reply's text so far while one is arriving, else `null`. */
  const [arriving, setArriving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The reply being regenerated: hidden while its replacement arrives. */
  const [replacing, setReplacing] = useState<Message | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    api.getChat(chatId).then(
      (loaded) => {
        if (current) setChat(loaded);
      },
      (reason: unknown) => {
        if (current) setLoadError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [chatId]);

  // A reply still being written by an earlier page (one that was reloaded
  // mid-reply) is saved when it ends: wait for it, then show it.
  const waitingForEarlierReply = chat?.replying === true && arriving === null;
  useEffect(() => {
    if (!waitingForEarlierReply) return;
    const timer = setTimeout(() => {
      api.getChat(chat.id).then(setChat, () => undefined);
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [waitingForEarlierReply, chat]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, arriving]);

  if (loadError !== null) {
    return (
      <p className="page" role="alert">
        {loadError}
      </p>
    );
  }
  if (chat === null) return <p className="page">Loading…</p>;

  const replying = arriving !== null || chat.replying;

  const addMessage = (message: Message): void => {
    setChat((before) =>
      before === null
        ? before
        : { ...before, messages: [...before.messages, message] },
    );
  };

  const removeMessage = (message: Message): void => {
    setChat((before) =>
      before === null
        ? before
        : {
            ...before,
            messages: before.messages.filter(({ id }) => id !== message.id),
          },
    );
  };

  /** Show a reply as it arrives. `old` is the reply it replaces, if any. */
  const follow = async (
    events: AsyncIterable<ReplyEvent>,
    old: Message | null = null,
  ): Promise<void> => {
    setError(null);
    setArriving('');
    setReplacing(old);
    for await (const event of events) {
      switch (event.type) {
        case 'user-message':
          addMessage(event.message);
          break;
        case 'delta':
          setArriving((text) => (text ?? '') + event.text);
          break;
        case 'done':
          if (event.message !== null) {
            if (old !== null) removeMessage(old);
            addMessage(event.message);
          }
          break;
        case 'error':
          setError(event.message);
          break;
      }
    }
    setArriving(null);
    setReplacing(null);
    // The conversation has changed, so where it stops being sent may have too.
    api.getChat(chat.id).then(setChat, () => undefined);
  };

  const last = chat.messages.at(-1);

  const regenerate = (): void => {
    void follow(
      api.regenerate(chat.id),
      last?.role === 'assistant' ? last : null,
    );
  };

  const deleteLast = (): void => {
    setError(null);
    api.deleteLastMessage(chat.id).then(setChat, (reason: unknown) => {
      setError(errorMessage(reason));
    });
  };

  const submit = (event?: SyntheticEvent): void => {
    event?.preventDefault();
    const content = draft.trim();
    if (content === '' || replying) return;
    setDraft('');
    void follow(api.sendMessage(chat.id, content));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const shown = chat.messages.filter(({ id }) => id !== replacing?.id);
  // A reply needs a message to answer: an opening message alone has none.
  const canRegenerate = last?.role === 'user' || chat.messages.length > 1;

  return (
    <div className="chat">
      <header className="page-header">
        <h1>{chat.character.name}</h1>
        <p>{chat.scenario.title}</p>
      </header>

      <div className="conversation-scroll">
        <ol className="conversation" aria-label="Conversation">
          {shown.map((message, index) => (
            <Fragment key={message.id}>
              {index === chat.notSent && index > 0 && (
                <li className="not-sent-marker">
                  Messages above this line are no longer sent to the model.
                </li>
              )}
              <MessageItem
                author={message.role === 'user' ? 'You' : chat.character.name}
                role={message.role}
                content={message.content}
              />
            </Fragment>
          ))}
          {arriving !== null && (
            <MessageItem
              author={chat.character.name}
              role="assistant"
              content={arriving === '' ? '…' : arriving}
              writing
            />
          )}
        </ol>
        {error !== null && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {!replying && last !== undefined && (
          <div className="conversation-actions">
            {canRegenerate && (
              <button type="button" onClick={regenerate}>
                {last.role === 'assistant' ? 'Regenerate' : 'Try again'}
              </button>
            )}
            <button type="button" onClick={deleteLast}>
              Delete last message
            </button>
          </div>
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          aria-label="Message"
          placeholder={`Message ${chat.character.name}`}
          rows={2}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {arriving !== null ? (
          <button type="button" onClick={() => void api.stopReply(chat.id)}>
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="primary"
            disabled={draft.trim() === '' || replying}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
