import { type ReactNode, useEffect, useState } from 'react';
import type { ReasoningEffort } from '../shared/api.ts';
import { api, errorMessage } from './api.ts';

const EFFORT_NAMES: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The levels a model takes, while they are being found out, or why they could not be. */
type Levels =
  | { state: 'checking' }
  | { state: 'known'; efforts: ReasoningEffort[] }
  | { state: 'failed'; reason: string };

/** The models to offer: the list, with the chosen one first if the list lacks it. */
function choices(models: string[], chosen: string): string[] {
  return chosen === '' || models.includes(chosen)
    ? models
    : [chosen, ...models];
}

/**
 * A model and its thinking level. The model is picked from `models`, or typed
 * when the list could not be had (`models` is a reason, not a list). The levels
 * on offer are the ones the chosen model takes; a level it does not take is
 * cleared back to the model's default.
 */
export function ModelField(props: {
  label: string;
  levelLabel: string;
  /** The models OpenAI offers, `undefined` while they load, or why they could not be listed. */
  models: string[] | undefined | { reason: string };
  model: string;
  onModel: (model: string) => void;
  effort: ReasoningEffort | null;
  onEffort: (effort: ReasoningEffort | null) => void;
  hint: ReactNode;
}) {
  const { models, model, effort, onEffort } = props;
  const typed = models !== undefined && !Array.isArray(models);
  // A typed model is checked once typing ends, not on every key: while the
  // field has focus, the model it held when focused is the one checked.
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const target = (typed && editing !== undefined ? editing : model).trim();
  const [found, setFound] = useState<
    ({ model: string } & Exclude<Levels, { state: 'checking' }>) | undefined
  >(undefined);
  const levels: Levels =
    found?.model === target ? found : { state: 'checking' };

  useEffect(() => {
    if (target === '') return undefined;
    let current = true;
    api.modelReasoning(target).then(
      ({ efforts }) => {
        if (current) setFound({ model: target, state: 'known', efforts });
      },
      (reason: unknown) => {
        if (current) {
          setFound({
            model: target,
            state: 'failed',
            reason: errorMessage(reason),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [target]);

  // A level the model does not take goes back to the model's default.
  useEffect(() => {
    if (
      found?.model === target &&
      found.state === 'known' &&
      effort !== null &&
      !found.efforts.includes(effort)
    ) {
      onEffort(null);
    }
  }, [found, target, effort, onEffort]);

  // Until the levels are known, the chosen one is still shown.
  const offered =
    levels.state === 'known' ? levels.efforts : effort === null ? [] : [effort];

  return (
    <>
      <label>
        {props.label}
        {typed ? (
          <input
            type="text"
            required
            value={model}
            onChange={(event) => {
              props.onModel(event.target.value);
            }}
            onFocus={() => {
              setEditing(model);
            }}
            onBlur={() => {
              setEditing(undefined);
            }}
          />
        ) : (
          <select
            required
            value={model}
            onChange={(event) => {
              props.onModel(event.target.value);
            }}
          >
            {choices(models ?? [], model).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
      </label>
      {typed && (
        <p className="hint" role="alert">
          The list of models could not be loaded, so type the name:{' '}
          {models.reason}
        </p>
      )}
      <p className="hint">{props.hint}</p>

      <label>
        {props.levelLabel}
        <select
          disabled={levels.state !== 'known' || levels.efforts.length === 0}
          value={effort ?? ''}
          onChange={(event) => {
            const { value } = event.target;
            onEffort(value === '' ? null : (value as ReasoningEffort));
          }}
        >
          <option value="">
            {levels.state === 'known' && levels.efforts.length === 0
              ? 'Not available for this model'
              : "The model's default"}
          </option>
          {offered.map((level) => (
            <option key={level} value={level}>
              {EFFORT_NAMES[level]}
            </option>
          ))}
        </select>
      </label>
      {levels.state === 'checking' && (
        <p className="hint">Checking which levels this model takes…</p>
      )}
      {levels.state === 'failed' && (
        <p className="hint" role="alert">
          Could not find out this model's thinking levels: {levels.reason}
        </p>
      )}
      <p className="hint">
        How long the model thinks before it answers. More thinking is slower and
        costs more.
      </p>
    </>
  );
}
