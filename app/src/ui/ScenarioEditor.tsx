import { type SyntheticEvent, useEffect, useState } from 'react';
import type { ScenarioInput } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';
import { navigate } from './router.ts';
import { TextField } from './TextField.tsx';

const BLANK: ScenarioInput = {
  title: '',
  premise: '',
  openingMessage: '',
  startingLocation: { name: '', description: '' },
};

/** Create a scenario, or edit the one with `id`. */
export function ScenarioEditor({ id }: { id?: string }) {
  const [scenario, setScenario] = useState<ScenarioInput | null>(
    id === undefined ? BLANK : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id === undefined) return;
    let current = true;
    api.getScenario(id).then(
      ({ title, premise, openingMessage, startingLocation }) => {
        if (current) {
          setScenario({
            title,
            premise,
            openingMessage,
            startingLocation,
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

  if (scenario === null) {
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
        ? api.createScenario(scenario)
        : api.updateScenario(id, scenario);
    saved.then(
      () => {
        navigate('/scenarios');
      },
      (reason: unknown) => {
        setError(errorMessage(reason));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>{id === undefined ? 'New scenario' : 'Edit scenario'}</h1>
      </header>
      <form className="form" onSubmit={save}>
        <TextField
          label="Title"
          required
          maxLength={100}
          value={scenario.title}
          onChange={(title) => {
            setScenario({ ...scenario, title });
          }}
        />
        <TextField
          label="Premise"
          hint="The situation the story starts from."
          rows={5}
          value={scenario.premise}
          onChange={(premise) => {
            setScenario({ ...scenario, premise });
          }}
        />

        <TextField
          label="Opening message"
          hint="The character's first message in a new chat. Leave it blank to speak first yourself."
          rows={4}
          value={scenario.openingMessage}
          onChange={(openingMessage) => {
            setScenario({ ...scenario, openingMessage });
          }}
        />

        <fieldset>
          <legend>Starting location</legend>
          <TextField
            label="Location name"
            maxLength={100}
            value={scenario.startingLocation.name}
            onChange={(name) => {
              setScenario({
                ...scenario,
                startingLocation: { ...scenario.startingLocation, name },
              });
            }}
          />
          <TextField
            label="Location description"
            hint="What the place where the story begins is like."
            rows={3}
            value={scenario.startingLocation.description}
            onChange={(description) => {
              setScenario({
                ...scenario,
                startingLocation: {
                  ...scenario.startingLocation,
                  description,
                },
              });
            }}
          />
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary">
            Save scenario
          </button>
          <a className="button" href="#/scenarios">
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
