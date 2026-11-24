import { type SyntheticEvent, useEffect, useState } from 'react';
import type {
  IllustrationMode,
  Settings,
  SettingsUpdate,
  SpeechScope,
} from '../shared/api.ts';
import { api } from './api.ts';

const KEY_SOURCE: Record<Settings['apiKey'], string> = {
  saved: 'Using the key saved here.',
  environment: 'Using the key from the OPENAI_API_KEY environment variable.',
  missing: 'No key is set. Chat cannot work without one.',
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [sceneModel, setSceneModel] = useState('');
  const [illustrationMode, setIllustrationMode] =
    useState<IllustrationMode>('key-moments');
  const [cooldown, setCooldown] = useState('');
  const [budget, setBudget] = useState('');
  const [speak, setSpeak] = useState(true);
  const [speechScope, setSpeechScope] = useState<SpeechScope>('dialogue');
  const [notice, setNotice] = useState<{
    kind: 'status' | 'alert';
    text: string;
  } | null>(null);

  const show = (loaded: Settings): void => {
    setSettings(loaded);
    setModel(loaded.model);
    setSceneModel(loaded.sceneModel);
    setIllustrationMode(loaded.illustrationMode);
    setCooldown(String(loaded.illustrationCooldown));
    setBudget(String(loaded.contextTokenBudget));
    setSpeak(!loaded.speechMuted);
    setSpeechScope(loaded.speechScope);
    setApiKey('');
  };

  const fail = (reason: unknown): void => {
    setNotice({
      kind: 'alert',
      text: reason instanceof Error ? reason.message : String(reason),
    });
  };

  useEffect(() => {
    let current = true;
    api.getSettings().then((loaded) => {
      if (current) show(loaded);
    }, fail);
    return () => {
      current = false;
    };
  }, []);

  if (settings === null) {
    return notice === null ? (
      <p>Loading…</p>
    ) : (
      <p role="alert">{notice.text}</p>
    );
  }

  const update = (change: SettingsUpdate, done: string): void => {
    setNotice(null);
    api.updateSettings(change).then((saved) => {
      show(saved);
      setNotice({ kind: 'status', text: done });
    }, fail);
  };

  const save = (event: SyntheticEvent): void => {
    event.preventDefault();
    update(
      {
        model,
        sceneModel,
        illustrationMode,
        illustrationCooldown: Number(cooldown),
        contextTokenBudget: Number(budget),
        speechMuted: !speak,
        speechScope,
        ...(apiKey.trim() !== '' && { apiKey: apiKey.trim() }),
      },
      'Settings saved.',
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <form className="form" onSubmit={save}>
        <label>
          OpenAI API key
          <input
            type="password"
            autoComplete="off"
            placeholder={
              settings.apiKey === 'saved' ? 'Replace the saved key' : 'sk-…'
            }
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
        </label>
        <p className="hint" data-testid="key-source">
          {KEY_SOURCE[settings.apiKey]}
        </p>
        <p className="hint">
          A key saved here is kept on this computer, outside the chatThree
          folder, and is used in place of OPENAI_API_KEY. It is sent only to
          OpenAI and is never shown again.
        </p>

        <label>
          Model
          <input
            type="text"
            required
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
            }}
          />
        </label>
        <p className="hint">The OpenAI model that writes the replies.</p>

        <label>
          Scene model
          <input
            type="text"
            required
            value={sceneModel}
            onChange={(event) => {
              setSceneModel(event.target.value);
            }}
          />
        </label>
        <p className="hint">
          The OpenAI model that reads the latest messages and describes the
          moment for an illustration. A small, cheap model does it well.
        </p>

        <label>
          Illustrate replies by themselves
          <select
            value={illustrationMode}
            onChange={(event) => {
              setIllustrationMode(event.target.value as IllustrationMode);
            }}
          >
            <option value="off">Off</option>
            <option value="scene-changes">Scene changes only</option>
            <option value="key-moments">Key moments</option>
            <option value="every-reply">Every reply</option>
          </select>
        </label>
        <p className="hint">
          After each reply the scene model reads it, follows the story to where
          it is, and says whether the moment is worth a picture. Scene changes
          only paints one when the story moves somewhere; Key moments also
          paints moments worth it, once the cooldown below has passed. Off
          paints nothing by itself, but still follows the story. Illustrate
          works in every mode.
        </p>

        <label>
          Cooldown (replies)
          <input
            type="number"
            required
            min={1}
            max={100}
            step={1}
            value={cooldown}
            onChange={(event) => {
              setCooldown(event.target.value);
            }}
          />
        </label>
        <p className="hint">
          In Key moments, how many replies must pass after a picture before
          another moment worth one is painted. A move is painted at once.
        </p>

        <label>
          Conversation budget (tokens)
          <input
            type="number"
            required
            min={100}
            step={1}
            value={budget}
            onChange={(event) => {
              setBudget(event.target.value);
            }}
          />
        </label>
        <p className="hint">
          How much of a conversation is sent to the model each turn, counted
          back from the newest message. Older messages stay in the chat but are
          no longer sent. The count is an estimate of four characters per token.
        </p>

        <label className="toggle">
          <input
            type="checkbox"
            checked={speak}
            onChange={(event) => {
              setSpeak(event.target.checked);
            }}
          />
          Speak replies aloud
        </label>
        <p className="hint">
          Replies are spoken by the engine as they arrive, a sentence at a time.
          This can also be switched in a chat.
        </p>

        <label>
          What is spoken
          <select
            value={speechScope}
            onChange={(event) => {
              setSpeechScope(event.target.value as SpeechScope);
            }}
          >
            <option value="dialogue">Only what the character says</option>
            <option value="everything">The whole reply</option>
          </select>
        </label>
        <p className="hint">
          What the character says is the text in quotation marks. In a reply
          that has none, it is everything outside *asterisks*. Formatting marks
          are never spoken.
        </p>

        <div className="form-actions">
          <button type="submit" className="primary">
            Save
          </button>
          {settings.apiKey === 'saved' && (
            <button
              type="button"
              onClick={() => {
                update({ apiKey: null }, 'The saved key was forgotten.');
              }}
            >
              Forget saved key
            </button>
          )}
        </div>
        {notice !== null && (
          <p
            role={notice.kind}
            className={notice.kind === 'alert' ? 'form-error' : 'hint'}
          >
            {notice.text}
          </p>
        )}
      </form>
    </div>
  );
}
