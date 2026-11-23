import { type SyntheticEvent, useEffect, useState } from 'react';
import type { Settings, SettingsUpdate } from '../shared/api.ts';
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
  const [notice, setNotice] = useState<{
    kind: 'status' | 'alert';
    text: string;
  } | null>(null);

  const show = (loaded: Settings): void => {
    setSettings(loaded);
    setModel(loaded.model);
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
      { model, ...(apiKey.trim() !== '' && { apiKey: apiKey.trim() }) },
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
