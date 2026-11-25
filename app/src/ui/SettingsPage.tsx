import { type SyntheticEvent, useEffect, useState } from 'react';
import type {
  IllustrationMode,
  ImageStyle,
  ReasoningEffort,
  Settings,
  SettingsUpdate,
  SpeechScope,
} from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { ModelField } from './ModelField.tsx';
import { ReplyPrompts } from './ReplyPrompts.tsx';

const KEY_SOURCE: Record<Settings['apiKey'], string> = {
  saved: 'Using the key saved here.',
  environment: 'Using the key from the OPENAI_API_KEY environment variable.',
  missing: 'No key is set. Chat cannot work without one.',
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<
    string[] | undefined | { reason: string }
  >(undefined);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [sceneModel, setSceneModel] = useState('');
  const [sceneEffort, setSceneEffort] = useState<ReasoningEffort | null>(null);
  const [illustrationMode, setIllustrationMode] =
    useState<IllustrationMode>('key-moments');
  const [cooldown, setCooldown] = useState('');
  const [imageStyle, setImageStyle] = useState<ImageStyle>('realistic');
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
    setEffort(loaded.reasoningEffort);
    setSceneModel(loaded.sceneModel);
    setSceneEffort(loaded.sceneReasoningEffort);
    setIllustrationMode(loaded.illustrationMode);
    setCooldown(String(loaded.illustrationCooldown));
    setImageStyle(loaded.imageStyle);
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
    api.listModels().then(
      (list) => {
        if (current) setModels(list.models);
      },
      (reason: unknown) => {
        if (current) setModels({ reason: errorMessage(reason) });
      },
    );
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
        reasoningEffort: effort,
        sceneModel,
        sceneReasoningEffort: sceneEffort,
        illustrationMode,
        illustrationCooldown: Number(cooldown),
        imageStyle,
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

        <ModelField
          label="Model"
          levelLabel="Thinking level"
          models={models}
          model={model}
          onModel={setModel}
          effort={effort}
          onEffort={setEffort}
          hint="The OpenAI model that writes the replies."
        />

        <ModelField
          label="Scene model"
          levelLabel="Scene thinking level"
          models={models}
          model={sceneModel}
          onModel={setSceneModel}
          effort={sceneEffort}
          onEffort={setSceneEffort}
          hint="The OpenAI model that reads the latest messages and describes the moment for an illustration. A small, cheap model does it well, at a low thinking level."
        />

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
          Picture style
          <select
            value={imageStyle}
            onChange={(event) => {
              setImageStyle(event.target.value as ImageStyle);
            }}
          >
            <option value="realistic">Realistic</option>
            <option value="illustration">Illustration</option>
          </select>
        </label>
        <p className="hint">
          How illustrations and places are painted: like photographs, or as
          painted illustrations. Pictures already painted keep their style; a
          place painted in the other style still pulls its scenes towards it
          until you generate it again.
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
      <ReplyPrompts />
    </div>
  );
}
