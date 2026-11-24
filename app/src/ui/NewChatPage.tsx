import { type SyntheticEvent, useEffect, useId, useState } from 'react';
import type { Character, Scenario } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';

/**
 * Start a chat by pairing a character with a scenario. `preselected` names
 * the ones to start with, as when arriving from a character's "Chat" button.
 */
export function NewChatPage({
  preselected,
}: {
  preselected: { characterId?: string; scenarioId?: string };
}) {
  const [choices, setChoices] = useState<{
    characters: Character[];
    scenarios: Scenario[];
  } | null>(null);
  const [characterId, setCharacterId] = useState(preselected.characterId);
  const [scenarioId, setScenarioId] = useState(preselected.scenarioId);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let current = true;
    Promise.all([api.listCharacters(), api.listScenarios()]).then(
      ([characters, scenarios]) => {
        if (current) setChoices({ characters, scenarios });
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (choices === null) {
    return (
      <div className="page">
        {error === null ? <p>Loading…</p> : <p role="alert">{error}</p>}
      </div>
    );
  }

  const { characters, scenarios } = choices;
  // A preselected ID that no longer exists falls back to the first choice.
  const character =
    characters.find((one) => one.id === characterId) ?? characters[0];
  const scenario =
    scenarios.find((one) => one.id === scenarioId) ?? scenarios[0];

  const start = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (character === undefined || scenario === undefined) return;
    setError(null);
    api.createChat(character.id, scenario.id).then(
      (chat) => {
        navigate(`/chats/${chat.id}`);
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>New chat</h1>
        <p>Choose who to talk to, and the story to tell.</p>
      </header>

      {character === undefined || scenario === undefined ? (
        <p>
          A chat needs a character and a scenario.{' '}
          {character === undefined && (
            <a href="#/characters/new">Create a character</a>
          )}
          {character === undefined && scenario === undefined && ' and '}
          {scenario === undefined && (
            <a href="#/scenarios/new">
              {character === undefined
                ? 'create a scenario'
                : 'Create a scenario'}
            </a>
          )}{' '}
          first.
        </p>
      ) : (
        <form className="form" onSubmit={start}>
          <div className="field">
            <label htmlFor={`${id}-character`}>Character</label>
            <select
              id={`${id}-character`}
              value={character.id}
              onChange={(event) => {
                setCharacterId(event.target.value);
              }}
            >
              {characters.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
            <p className="hint choice-excerpt">{character.persona}</p>
          </div>

          <div className="field">
            <label htmlFor={`${id}-scenario`}>Scenario</label>
            <select
              id={`${id}-scenario`}
              value={scenario.id}
              onChange={(event) => {
                setScenarioId(event.target.value);
              }}
            >
              {scenarios.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
            <p className="hint choice-excerpt">{scenario.premise}</p>
          </div>

          <div className="form-actions">
            <button type="submit" className="primary">
              Start chat
            </button>
          </div>
          {error !== null && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
