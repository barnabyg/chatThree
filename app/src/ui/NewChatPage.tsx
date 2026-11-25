import { type SyntheticEvent, useEffect, useId, useState } from 'react';
import type { Character, Player, Scenario } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';

/** The player choice that plays as no one. */
const NO_PLAYER = '';

/**
 * Start a chat by pairing a character with a scenario, played as one of the
 * user's players or as no one. `preselected` names the ones to start with,
 * as when arriving from a character's "Chat" button.
 */
export function NewChatPage({
  preselected,
}: {
  preselected: { characterId?: string; scenarioId?: string; playerId?: string };
}) {
  const [choices, setChoices] = useState<{
    characters: Character[];
    scenarios: Scenario[];
    players: Player[];
  } | null>(null);
  const [characterId, setCharacterId] = useState(preselected.characterId);
  const [scenarioId, setScenarioId] = useState(preselected.scenarioId);
  const [playerId, setPlayerId] = useState(preselected.playerId);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let current = true;
    Promise.all([
      api.listCharacters(),
      api.listScenarios(),
      api.listPlayers(),
    ]).then(
      ([characters, scenarios, players]) => {
        if (current) setChoices({ characters, scenarios, players });
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

  const { characters, scenarios, players } = choices;
  // A preselected ID that no longer exists falls back to the first choice.
  const character =
    characters.find((one) => one.id === characterId) ?? characters[0];
  const scenario =
    scenarios.find((one) => one.id === scenarioId) ?? scenarios[0];
  // No player is a choice of its own, so it is kept when chosen.
  const player =
    playerId === NO_PLAYER
      ? undefined
      : (players.find((one) => one.id === playerId) ?? players[0]);

  const start = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (character === undefined || scenario === undefined) return;
    setError(null);
    api.createChat(character.id, scenario.id, player?.id ?? null).then(
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
        <p>Choose who to talk to, the story to tell, and who you play.</p>
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

          <div className="field">
            <label htmlFor={`${id}-player`}>Player</label>
            <select
              id={`${id}-player`}
              value={player?.id ?? NO_PLAYER}
              onChange={(event) => {
                setPlayerId(event.target.value);
              }}
            >
              {players.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
              <option value={NO_PLAYER}>No player</option>
            </select>
            <p className="hint choice-excerpt">
              {player === undefined ? (
                <>
                  You play no one in particular.{' '}
                  <a href="#/players/new">Create a player</a>
                </>
              ) : (
                player.background
              )}
            </p>
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
