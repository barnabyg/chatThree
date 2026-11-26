import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Chat, Message, ReplyEvent, Settings } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { MessageIllustrations } from './Illustrations.tsx';
import { Locations } from './Locations.tsx';
import { useSpeech } from './speech/useSpeech.ts';

/** The server's limit on one message. */
const MAX_MESSAGE_LENGTH = 20_000;
/** How often the chat is looked at again while a picture is being made. */
const ILLUSTRATION_POLL_MS = 1_000;

/** What belongs to a chat's pictures and places, which change in the background. */
function scenePart({
  illustrations,
  illustrating,
  followingScene,
  location,
  locations,
}: Chat): Pick<
  Chat,
  'illustrations' | 'illustrating' | 'followingScene' | 'location' | 'locations'
> {
  return { illustrations, illustrating, followingScene, location, locations };
}

function MessageItem({
  author,
  role,
  content,
  writing = false,
  onReplay,
  children,
}: {
  author: string;
  role: Message['role'];
  content: string;
  writing?: boolean;
  /** Speak the message again. Without it, there is no replay button. */
  onReplay?: () => void;
  /** Shown under the message's text. */
  children?: ReactNode;
}) {
  return (
    <li className={`message message-${role}`} aria-busy={writing}>
      <div className="message-header">
        <p className="message-author">{author}</p>
        {onReplay !== undefined && (
          <button
            type="button"
            className="icon-button"
            aria-label="Replay message"
            title="Replay message"
            onClick={onReplay}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 6h3l4-3.5v11L5 10H2z" />
              <path
                d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <p className="message-content">{content}</p>
      {children}
    </li>
  );
}

export function ChatPage({ chatId }: { chatId: string }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The reply's text so far while one is arriving, else `null`. */
  const [arriving, setArriving] = useState<string | null>(null);
  /** Whether the model is thinking before the reply that is arriving. */
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The reply being regenerated: hidden while its replacement arrives. */
  const [replacing, setReplacing] = useState<Message | null>(null);
  /** Unknown until loaded; until then nothing is spoken. */
  const [settings, setSettings] = useState<Settings | null>(null);
  const speech = useSpeech();
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

  useEffect(() => {
    let current = true;
    api.getSettings().then(
      (loaded) => {
        if (current) setSettings(loaded);
      },
      // Without settings the chat still works; it is only not spoken.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  // The character's voice is made ready when the chat opens, so that the
  // first sentence of the first reply does not wait for it.
  const characterId = chat?.character.id;
  const speaks = settings?.speechMuted === false;
  useEffect(() => {
    if (characterId !== undefined && speaks) api.warmVoice(characterId);
  }, [characterId, speaks]);

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

  // While pictures are being made, or the scene call is reading the latest
  // reply (after which one may start), look again until that is done. Only
  // what belongs to the pictures and places is taken: the conversation is
  // this page's.
  const illustrating =
    chat?.followingScene === true ||
    chat?.illustrating.some(({ state }) => state !== 'failed') === true;
  useEffect(() => {
    if (!illustrating) return;
    const timer = setInterval(() => {
      api.getChat(chatId).then(
        (loaded) => {
          setChat((before) => before && { ...before, ...scenePart(loaded) });
        },
        () => undefined,
      );
    }, ILLUSTRATION_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [illustrating, chatId]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, chat?.illustrations.length, arriving]);

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

  /**
   * Show a reply as it arrives. `old` is the reply it replaces, if any.
   * Resolves to whether the user's own message was saved on the way.
   */
  const follow = async (
    events: AsyncIterable<ReplyEvent>,
    old: Message | null = null,
  ): Promise<boolean> => {
    let userMessageSaved = false;
    setError(null);
    setArriving('');
    setThinking(false);
    setReplacing(old);
    // A new reply is spoken in place of whatever was still being said.
    speech.stop();
    const spoken =
      settings?.speechMuted === false
        ? speech.begin({
            scope: settings.speechScope,
            characterId: chat.character.id,
            previous: chat.messages.findLast(({ role }) => role === 'assistant')
              ?.content,
          })
        : null;
    for await (const event of events) {
      switch (event.type) {
        case 'user-message':
          userMessageSaved = true;
          addMessage(event.message);
          break;
        case 'thinking':
          setThinking(true);
          break;
        case 'delta':
          setArriving((text) => (text ?? '') + event.text);
          spoken?.push(event.text);
          break;
        case 'done':
          if (event.message !== null) {
            if (old !== null) removeMessage(old);
            addMessage(event.message);
          }
          spoken?.end();
          break;
        case 'error':
          setError(event.message);
          // The reply was not kept, so it is not spoken either.
          speech.stop();
          break;
      }
    }
    setArriving(null);
    setReplacing(null);
    // The conversation has changed, so where it stops being sent may have too.
    api.getChat(chat.id).then(setChat, () => undefined);
    return userMessageSaved;
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
    void follow(api.sendMessage(chat.id, content)).then((saved) => {
      // A message the app did not take goes back in the box, not in the bin.
      if (!saved) setDraft((now) => (now === '' ? content : now));
    });
  };

  const illustrate = (messageId: number): void => {
    setError(null);
    api.illustrate(chat.id, messageId).then(
      (loaded) => {
        setChat((before) => before && { ...before, ...scenePart(loaded) });
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  /** Speak `message` again, even when replies are not spoken by themselves. */
  const replay = (message: Message): void => {
    const index = chat.messages.indexOf(message);
    speech.replay(
      {
        scope: settings?.speechScope ?? 'dialogue',
        characterId: chat.character.id,
        previous: chat.messages
          .slice(0, index)
          .findLast(({ role }) => role === 'assistant')?.content,
      },
      message.content,
    );
  };

  const stopReply = (): void => {
    speech.stop();
    void api.stopReply(chat.id);
  };

  const setSpeaking = (speak: boolean): void => {
    if (!speak) speech.stop();
    const withMuted = (speechMuted: boolean): void => {
      setSettings((before) => before && { ...before, speechMuted });
    };
    // Shown at once; put back if it could not be saved.
    withMuted(!speak);
    api
      .updateSettings({ speechMuted: !speak })
      .then(setSettings, (reason: unknown) => {
        withMuted(speak);
        setError(errorMessage(reason));
      });
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
      <header className="page-header with-action">
        <div>
          <h1>{chat.character.name}</h1>
          <p>{chat.scenario.title}</p>
          {chat.player !== null && <p>Playing as {chat.player.name}</p>}
          {chat.replyPrompt !== null && (
            <p>Reply prompt: {chat.replyPrompt.name}</p>
          )}
          <p className="chat-location" data-testid="current-location">
            At {chat.location.name}
          </p>
          <Locations
            chatId={chat.id}
            current={chat.location}
            locations={chat.locations}
            onChange={(loaded) => {
              setChat(
                (before) => before && { ...before, ...scenePart(loaded) },
              );
            }}
          />
        </div>
        {settings !== null && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={!settings.speechMuted}
              onChange={(event) => {
                setSpeaking(event.target.checked);
              }}
            />
            Speak replies
          </label>
        )}
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
                onReplay={
                  message.role === 'assistant'
                    ? () => {
                        replay(message);
                      }
                    : undefined
                }
              >
                {message.role === 'assistant' && (
                  <MessageIllustrations
                    characterName={chat.character.name}
                    characterId={chat.character.id}
                    hasPicture={chat.character.imageUrl !== null}
                    illustrations={chat.illustrations.filter(
                      ({ messageId }) => messageId === message.id,
                    )}
                    progress={chat.illustrating.find(
                      ({ messageId }) => messageId === message.id,
                    )}
                    onIllustrate={() => {
                      illustrate(message.id);
                    }}
                  />
                )}
              </MessageItem>
            </Fragment>
          ))}
          {arriving !== null && (
            <MessageItem
              author={chat.character.name}
              role="assistant"
              content={
                arriving !== '' ? arriving : thinking ? 'Thinking…' : '…'
              }
              writing
            />
          )}
        </ol>
        {error !== null && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {speech.problem !== null && (
          <p className="speech-problem" role="status">
            {speech.problem}
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
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {arriving !== null ? (
          <button type="button" onClick={stopReply}>
            Stop
          </button>
        ) : (
          <>
            {speech.speaking && (
              <button
                type="button"
                onClick={() => {
                  speech.stop();
                }}
              >
                Stop speaking
              </button>
            )}
            <button
              type="submit"
              className="primary"
              disabled={draft.trim() === '' || replying}
            >
              Send
            </button>
          </>
        )}
      </form>
    </div>
  );
}
