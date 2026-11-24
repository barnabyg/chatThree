import { type SyntheticEvent, useEffect, useState } from 'react';
import type { CharacterInput } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';
import { TextField } from './TextField.tsx';

const BLANK: CharacterInput = {
  name: '',
  persona: '',
  speakingStyle: '',
  exampleDialogue: '',
  appearance: '',
};

const TEXT_FIELDS: {
  field: Exclude<keyof CharacterInput, 'name'>;
  label: string;
  hint: string;
  rows: number;
}[] = [
  {
    field: 'persona',
    label: 'Persona',
    hint: 'Who they are: their history, their nature, what they want.',
    rows: 6,
  },
  {
    field: 'speakingStyle',
    label: 'Speaking style',
    hint: 'How they talk: rhythm, vocabulary, habits of speech.',
    rows: 3,
  },
  {
    field: 'exampleDialogue',
    label: 'Example dialogue',
    hint: 'A few sample exchanges that show their voice.',
    rows: 6,
  },
  {
    field: 'appearance',
    label: 'Appearance',
    hint: 'What they look like. Kept for pictures of the character; it is not part of the chat prompt.',
    rows: 3,
  },
];

/** Create a character, or edit the one with `id`. */
export function CharacterEditor({ id }: { id?: string }) {
  const [character, setCharacter] = useState<CharacterInput | null>(
    id === undefined ? BLANK : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let current = true;
    api.getCharacter(id).then(
      ({ name, persona, speakingStyle, exampleDialogue, appearance }) => {
        if (current) {
          setCharacter({
            name,
            persona,
            speakingStyle,
            exampleDialogue,
            appearance,
          });
        }
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  if (character === null) {
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
        ? api.createCharacter(character)
        : api.updateCharacter(id, character);
    saved.then(
      () => {
        navigate('/characters');
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{id === undefined ? 'New character' : 'Edit character'}</h1>
      </header>
      <form className="form" onSubmit={save}>
        <TextField
          label="Name"
          required
          maxLength={100}
          value={character.name}
          onChange={(name) => {
            setCharacter({ ...character, name });
          }}
        />
        {TEXT_FIELDS.map(({ field, label, hint, rows }) => (
          <TextField
            key={field}
            label={label}
            hint={hint}
            rows={rows}
            value={character[field]}
            onChange={(value) => {
              setCharacter({ ...character, [field]: value });
            }}
          />
        ))}
        <div className="form-actions">
          <button type="submit" className="primary">
            Save character
          </button>
          <a className="button" href="#/characters">
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
