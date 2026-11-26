import { type SyntheticEvent, useEffect, useState } from 'react';
import type {
  IllustrationMode,
  ImageStyle,
  KoboldCppStatus,
  ReasoningEffort,
  Settings,
  SettingsUpdate,
  SpeechScope,
  TextBackend,
} from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { ModelField } from './ModelField.tsx';
import { ProfileEditor } from './ProfileEditor.tsx';
import { ReplyPrompts } from './ReplyPrompts.tsx';

/** The tabs of the Settings page, each at `#/settings/<id>`. */
export const SETTINGS_TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'text', label: 'Text' },
  { id: 'images', label: 'Images' },
  { id: 'speech', label: 'Speech' },
  { id: 'reply-prompts', label: 'Reply prompts' },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

/** The tab named in a route, or the first tab when it names none. */
export function settingsTab(id: string | undefined): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab.id === id)?.id ?? 'connection';
}

const KEY_SOURCE: Record<Settings['apiKey'], string> = {
  saved: 'Using the key saved here.',
  environment: 'Using the key from the OPENAI_API_KEY environment variable.',
  missing: 'No key is set. Chat cannot work without one.',
};

/**
 * The settings, in tabs. Unsaved changes are kept while moving between the
 * tabs, and Save saves them all.
 */
export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [textBackend, setTextBackend] = useState<TextBackend>('openai');
  const [koboldAddress, setKoboldAddress] = useState('');
  /** The last connection test: what it found, why it failed, or still going. */
  const [koboldCheck, setKoboldCheck] = useState<
    | { state: 'checking' }
    | { state: 'found'; status: KoboldCppStatus }
    | { state: 'failed'; reason: string }
    | undefined
  >(undefined);
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
  /** Words, or `''` for no suggested reply length. */
  const [replyLength, setReplyLength] = useState('');
  const [speak, setSpeak] = useState(true);
  const [speechScope, setSpeechScope] = useState<SpeechScope>('dialogue');
  const [notice, setNotice] = useState<{
    kind: 'status' | 'alert';
    text: string;
  } | null>(null);

  const show = (loaded: Settings): void => {
    setSettings(loaded);
    setTextBackend(loaded.textBackend);
    setKoboldAddress(loaded.koboldcppAddress);
    setModel(loaded.model);
    setEffort(loaded.reasoningEffort);
    setSceneModel(loaded.sceneModel);
    setSceneEffort(loaded.sceneReasoningEffort);
    setIllustrationMode(loaded.illustrationMode);
    setCooldown(String(loaded.illustrationCooldown));
    setImageStyle(loaded.imageStyle);
    setBudget(String(loaded.contextTokenBudget));
    setReplyLength(
      loaded.replyLengthWords === null ? '' : String(loaded.replyLengthWords),
    );
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

  /** Load the models of the saved backend. `current` says whether the page still wants them. */
  const loadModels = (current: () => boolean = () => true): void => {
    api.listModels().then(
      (list) => {
        if (current()) setModels(list.models);
      },
      (reason: unknown) => {
        if (current()) setModels({ reason: errorMessage(reason) });
      },
    );
  };

  useEffect(() => {
    let current = true;
    api.getSettings().then((loaded) => {
      if (current) show(loaded);
    }, fail);
    loadModels(() => current);
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
      const backendChanged =
        saved.textBackend !== settings.textBackend ||
        saved.koboldcppAddress !== settings.koboldcppAddress;
      show(saved);
      setNotice({ kind: 'status', text: done });
      // The models on offer are the saved backend's.
      if (backendChanged) {
        setModels(undefined);
        loadModels();
      }
    }, fail);
  };

  const testConnection = (): void => {
    setKoboldCheck({ state: 'checking' });
    api.checkKoboldCpp(koboldAddress).then(
      (status) => {
        setKoboldCheck({ state: 'found', status });
      },
      (reason: unknown) => {
        setKoboldCheck({ state: 'failed', reason: errorMessage(reason) });
      },
    );
  };

  /** The model KoboldCpp has loaded, as far as the page knows. */
  const loadedModel =
    koboldCheck?.state === 'found'
      ? koboldCheck.status.model
      : settings.textBackend === 'koboldcpp' &&
          settings.koboldcppAddress === koboldAddress.trim() &&
          Array.isArray(models)
        ? models[0]
        : undefined;
  const local = textBackend === 'koboldcpp';
  // The OpenAI models are listed only once OpenAI is the saved backend.
  const openAIModels =
    settings.textBackend === 'openai'
      ? models
      : { reason: 'Save to list the OpenAI models.' };

  const save = (event: SyntheticEvent): void => {
    event.preventDefault();
    update(
      {
        textBackend,
        koboldcppAddress: koboldAddress,
        model,
        reasoningEffort: effort,
        sceneModel,
        sceneReasoningEffort: sceneEffort,
        illustrationMode,
        illustrationCooldown: Number(cooldown),
        imageStyle,
        contextTokenBudget: Number(budget),
        replyLengthWords:
          replyLength.trim() === '' ? null : Number(replyLength),
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
      <nav className="tabs" aria-label="Settings">
        {SETTINGS_TABS.map(({ id, label }) => (
          <a
            key={id}
            href={`#/settings/${id}`}
            aria-current={id === tab ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {tab === 'reply-prompts' ? (
        <ReplyPrompts />
      ) : (
        <>
          <form className="form" onSubmit={save}>
            {tab === 'text' && (
              <>
                <label>
                  Suggested reply length (words)
                  <input
                    type="number"
                    min={10}
                    max={2000}
                    step={1}
                    placeholder="No suggestion"
                    value={replyLength}
                    onChange={(event) => {
                      setReplyLength(event.target.value);
                    }}
                  />
                </label>
                <p className="hint">
                  About how long each reply should be. The model is asked to
                  keep to it, with either backend, but may run over. Leave it
                  blank to let the model choose.
                  {settings.textBackend === 'koboldcpp' &&
                    ' The profile’s reply length below is the hard limit, in tokens.'}
                </p>
              </>
            )}
            {tab === 'connection' && (
              <>
                <label>
                  Text backend
                  <select
                    value={textBackend}
                    onChange={(event) => {
                      setTextBackend(event.target.value as TextBackend);
                    }}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="koboldcpp">KoboldCpp</option>
                  </select>
                </label>
                <p className="hint">
                  Who writes the replies and describes scenes for illustrations:
                  OpenAI, or a local model loaded in KoboldCpp, usually on
                  another PC on your network.
                </p>
              </>
            )}
            {tab === 'connection' && local && (
              <>
                <label>
                  Server address
                  <input
                    type="text"
                    required
                    placeholder="http://192.168.1.50:5001"
                    value={koboldAddress}
                    onChange={(event) => {
                      setKoboldAddress(event.target.value);
                      setKoboldCheck(undefined);
                    }}
                  />
                </label>
                <p className="hint">
                  Where KoboldCpp is listening, such as
                  http://192.168.1.50:5001. chatThree adds the paths itself. Use
                  the PC’s IPv4 address: a .local name may not work. Nothing
                  else is sent to KoboldCpp, and never the OpenAI key.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    disabled={
                      koboldAddress.trim() === '' ||
                      koboldCheck?.state === 'checking'
                    }
                    onClick={testConnection}
                  >
                    Test connection
                  </button>
                </div>
                {koboldCheck?.state === 'checking' && (
                  <p className="hint" role="status">
                    Connecting…
                  </p>
                )}
                {koboldCheck?.state === 'found' && (
                  <p className="hint" role="status">
                    Connected. {koboldCheck.status.model} is loaded, with a
                    context of{' '}
                    {koboldCheck.status.contextLength.toLocaleString('en')}{' '}
                    tokens.
                  </p>
                )}
                {koboldCheck?.state === 'failed' && (
                  <p className="form-error" role="alert">
                    {koboldCheck.reason}
                  </p>
                )}

                <label>
                  Loaded model
                  <input
                    type="text"
                    readOnly
                    value={loadedModel ?? ''}
                    placeholder="Test the connection to see it"
                  />
                </label>
                <p className="hint">
                  The model loaded in KoboldCpp writes everything. To use
                  another, load it in KoboldCpp. How much of a conversation is
                  sent follows its context length, less room for the reply and
                  the character's instructions.
                </p>
              </>
            )}
            {tab === 'connection' && !local && (
              <>
                <label>
                  OpenAI API key
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      settings.apiKey === 'saved'
                        ? 'Replace the saved key'
                        : 'sk-…'
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
                  A key saved here is kept on this computer, outside the
                  chatThree folder, and is used in place of OPENAI_API_KEY. It
                  is sent only to OpenAI and is never shown again.
                </p>

                <ModelField
                  label="Model"
                  levelLabel="Thinking level"
                  models={openAIModels}
                  model={model}
                  onModel={setModel}
                  effort={effort}
                  onEffort={setEffort}
                  hint="The OpenAI model that writes the replies."
                />
              </>
            )}
            {tab === 'connection' && !local && (
              <>
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
                  How much of a conversation is sent to the model each turn,
                  counted back from the newest message. Older messages stay in
                  the chat but are no longer sent. The count is an estimate of
                  four characters per token.
                </p>
              </>
            )}
            {tab === 'images' && (
              <>
                {!local && (
                  <ModelField
                    label="Scene model"
                    levelLabel="Scene thinking level"
                    models={openAIModels}
                    model={sceneModel}
                    onModel={setSceneModel}
                    effort={sceneEffort}
                    onEffort={setSceneEffort}
                    hint="The OpenAI model that reads the latest messages and describes the moment for an illustration. A small, cheap model does it well, at a low thinking level."
                  />
                )}
                {local && (
                  <p className="hint">
                    Scenes are described by the model loaded in KoboldCpp.
                  </p>
                )}

                <label>
                  Illustrate replies by themselves
                  <select
                    value={illustrationMode}
                    onChange={(event) => {
                      setIllustrationMode(
                        event.target.value as IllustrationMode,
                      );
                    }}
                  >
                    <option value="off">Off</option>
                    <option value="scene-changes">Scene changes only</option>
                    <option value="key-moments">Key moments</option>
                    <option value="every-reply">Every reply</option>
                  </select>
                </label>
                <p className="hint">
                  After each reply the scene model reads it, follows the story
                  to where it is, and says whether the moment is worth a
                  picture. Scene changes only paints one when the story moves
                  somewhere; Key moments also paints moments worth it, once the
                  cooldown below has passed. Off paints nothing by itself, but
                  still follows the story. Illustrate works in every mode.
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
                  In Key moments, how many replies must pass after a picture
                  before another moment worth one is painted. A move is painted
                  at once.
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
                  How illustrations and places are painted: like photographs, or
                  as painted illustrations. Pictures already painted keep their
                  style; a place painted in the other style still pulls its
                  scenes towards it until you generate it again.
                </p>
              </>
            )}
            {tab === 'speech' && (
              <>
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
                  Replies are spoken by the engine as they arrive, a sentence at
                  a time. This can also be switched in a chat.
                </p>

                <label>
                  What is spoken
                  <select
                    value={speechScope}
                    onChange={(event) => {
                      setSpeechScope(event.target.value as SpeechScope);
                    }}
                  >
                    <option value="dialogue">
                      Only what the character says
                    </option>
                    <option value="everything">The whole reply</option>
                  </select>
                </label>
                <p className="hint">
                  What the character says is the text in quotation marks. In a
                  reply that has none, it is everything outside *asterisks*.
                  Formatting marks are never spoken.
                </p>
              </>
            )}
            <div className="form-actions">
              <button type="submit" className="primary">
                Save
              </button>
              {tab === 'connection' &&
                !local &&
                settings.apiKey === 'saved' && (
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
          {tab === 'text' &&
            (settings.textBackend === 'koboldcpp' ? (
              <ProfileEditor />
            ) : (
              <p className="hint">
                The model profile is for a local model in KoboldCpp. Choose
                KoboldCpp as the text backend under Connection, and save, to
                edit it. OpenAI's model is chosen under Connection.
              </p>
            ))}
        </>
      )}
    </div>
  );
}
