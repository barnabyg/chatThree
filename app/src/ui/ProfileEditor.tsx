import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useState,
} from 'react';
import {
  type LoadedModelProfile,
  type ModelProfile,
  PROFILE_NUMBERS,
  type ProfileField,
  type ProfileNumberField,
} from '../shared/api.ts';
import { api, errorMessage, FieldError } from './api.ts';

/** The profile's fields as the form holds them, as typed. */
interface Form {
  /** A preset chosen by hand, or `''` for the one the model matches. */
  preset: string;
  numbers: Record<ProfileNumberField, string>;
  /** Each with new lines and tabs written as `\n` and `\t`. */
  stop: string[];
  systemRole: ModelProfile['systemRole'];
  thinkingMode: ModelProfile['thinking']['mode'];
  open: string;
  close: string;
  extraBody: string;
}

const NUMBERS: { field: ProfileNumberField; label: string; hint: string }[] = [
  {
    field: 'contextLength',
    label: 'Context length (tokens)',
    hint: 'How much the model can read at once. Leave it blank for what KoboldCpp was started with.',
  },
  {
    field: 'maxReplyTokens',
    label: 'Reply length (tokens)',
    hint: 'The most a reply can be. A thinking model’s thinking counts against it.',
  },
  {
    field: 'temperature',
    label: 'Temperature',
    hint: 'Higher is more varied.',
  },
  { field: 'top_p', label: 'Top P', hint: '' },
  { field: 'top_k', label: 'Top K', hint: '0 turns it off.' },
  { field: 'min_p', label: 'Min P', hint: '' },
  { field: 'rep_pen', label: 'Repetition penalty', hint: '1 turns it off.' },
  {
    field: 'rep_pen_range',
    label: 'Repetition penalty range (tokens)',
    hint: 'How far back the penalty looks.',
  },
  {
    field: 'sceneTemperature',
    label: 'Scene call temperature',
    hint: 'For describing scenes: low keeps to the facts.',
  },
];

/** `text` with new lines, tabs and backslashes written out, for one line. */
function escape(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
}

function unescape(text: string): string {
  return text.replace(/\\([nt\\])/g, (_, code: string) =>
    code === 'n' ? '\n' : code === 't' ? '\t' : '\\',
  );
}

function toForm(profile: ModelProfile, preset: string): Form {
  const numbers = Object.fromEntries(
    NUMBERS.map(({ field }) => [field, String(profile[field] ?? '')]),
  ) as Record<ProfileNumberField, string>;
  return {
    preset,
    numbers,
    stop: profile.stop.map(escape),
    systemRole: profile.systemRole,
    thinkingMode: profile.thinking.mode,
    open: profile.thinking.mode === 'strip' ? profile.thinking.open : '<think>',
    close:
      profile.thinking.mode === 'strip' ? profile.thinking.close : '</think>',
    extraBody: JSON.stringify(profile.extraBody, null, 2),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseNumber(
  field: ProfileNumberField,
  label: string,
  text: string,
): Parsed<number | null> {
  const { min, max, whole } = PROFILE_NUMBERS[field];
  const trimmed = text.trim();
  if (trimmed === '' && field === 'contextLength') {
    return { ok: true, value: null };
  }
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(value)) {
    return { ok: false, error: `${label} must be a number.` };
  }
  if (whole && !Number.isInteger(value)) {
    return { ok: false, error: `${label} must be a whole number.` };
  }
  if (value < min || value > max) {
    return {
      ok: false,
      error: `${label} must be from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}.`,
    };
  }
  return { ok: true, value };
}

/** The value of `field` in `form`, or why it is not valid. */
function parseField(field: ProfileField, form: Form): Parsed<unknown> {
  const number = NUMBERS.find((entry) => entry.field === field);
  if (number !== undefined) {
    return parseNumber(number.field, number.label, form.numbers[number.field]);
  }
  switch (field) {
    case 'stop': {
      const stop = form.stop.map(unescape);
      return stop.includes('')
        ? { ok: false, error: 'A stop sequence cannot be empty: remove it.' }
        : { ok: true, value: stop };
    }
    case 'systemRole':
      return { ok: true, value: form.systemRole };
    case 'thinking':
      if (form.thinkingMode === 'none') {
        return { ok: true, value: { mode: 'none' } };
      }
      return form.open === '' || form.close === ''
        ? { ok: false, error: 'Stripping thinking needs both tags.' }
        : {
            ok: true,
            value: { mode: 'strip', open: form.open, close: form.close },
          };
    case 'extraBody': {
      let value: unknown;
      try {
        value = JSON.parse(
          form.extraBody.trim() === '' ? '{}' : form.extraBody,
        );
      } catch (error) {
        return {
          ok: false,
          error: `This is not valid JSON: ${errorMessage(error)}`,
        };
      }
      return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
        ? { ok: true, value }
        : { ok: false, error: 'This must be a JSON object, in { }.' };
    }
    default:
      return { ok: false, error: 'Unknown field.' };
  }
}

const FIELDS: ProfileField[] = [
  ...NUMBERS.map(({ field }) => field),
  'stop',
  'systemRole',
  'thinking',
  'extraBody',
];

/** The form with `field` set to `profile`'s value for it. */
function withValue(
  form: Form,
  field: ProfileField,
  profile: ModelProfile,
): Form {
  const from = toForm(profile, form.preset);
  switch (field) {
    case 'stop':
      return { ...form, stop: from.stop };
    case 'systemRole':
      return { ...form, systemRole: from.systemRole };
    case 'thinking':
      return {
        ...form,
        thinkingMode: from.thinkingMode,
        open: from.open,
        close: from.close,
      };
    case 'extraBody':
      return { ...form, extraBody: from.extraBody };
    default:
      return {
        ...form,
        numbers: { ...form.numbers, [field]: from.numbers[field] },
      };
  }
}

/** One field: its label, whether it is changed, a reset and its error. */
function Field({
  label,
  hint,
  changed,
  onReset,
  error,
  children,
}: {
  label: string;
  hint?: string;
  changed: boolean;
  onReset: () => void;
  error: string | undefined;
  children: (props: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const described = [
    ...(hint !== undefined && hint !== '' ? [`${id}-hint`] : []),
    ...(error !== undefined ? [`${id}-error`] : []),
  ].join(' ');
  return (
    <div className="field profile-field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        {changed && (
          <>
            <span className="changed">Changed</span>
            <button
              type="button"
              className="small"
              aria-label={`Reset ${label}`}
              onClick={onReset}
            >
              Reset
            </button>
          </>
        )}
      </div>
      {children({
        id,
        ...(error !== undefined && { 'aria-invalid': true as const }),
        ...(described !== '' && { 'aria-describedby': described }),
      })}
      {hint !== undefined && hint !== '' && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="form-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The profile of the model KoboldCpp has loaded: its preset, and every
 * field, which the user can change, reset to the preset's value, or reset
 * all at once. Saved apart from the rest of the settings.
 */
export function ProfileEditor() {
  const [loaded, setLoaded] = useState<
    LoadedModelProfile | { reason: string } | null
  >(null);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [notice, setNotice] = useState<{
    kind: 'status' | 'alert';
    text: string;
  } | null>(null);

  const show = (view: LoadedModelProfile): void => {
    setLoaded(view);
    setForm(toForm(view.profile, view.presetChosen ? view.preset : ''));
    setErrors({});
  };

  useEffect(() => {
    let current = true;
    api.getModelProfile().then(
      (view) => {
        if (current) show(view);
      },
      (reason: unknown) => {
        if (current) setLoaded({ reason: errorMessage(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (loaded === null) return <p>Loading…</p>;
  if ('reason' in loaded) {
    return (
      <p className="form-error" role="alert">
        {loaded.reason}
      </p>
    );
  }
  if (form === null) return null;

  const presetNamed = (name: string): ModelProfile =>
    loaded.presets.find((preset) => preset.name === name)?.profile ??
    loaded.profile;
  const presetName = form.preset === '' ? loaded.matchedPreset : form.preset;
  const preset = presetNamed(presetName);

  const isChanged = (field: ProfileField, against = preset): boolean => {
    const parsed = parseField(field, form);
    return (
      !parsed.ok ||
      JSON.stringify(parsed.value) !== JSON.stringify(against[field])
    );
  };

  /** Take `next` as the form, clearing the error of `field`, which changed. */
  const change = (next: Form, field: ProfileField | 'preset'): void => {
    setForm(next);
    setNotice(null);
    setErrors((before) =>
      Object.fromEntries(
        Object.entries(before).filter(([key]) => key !== field),
      ),
    );
  };

  const choosePreset = (name: string): void => {
    // Fields that were not changed follow the new preset.
    const next = presetNamed(name === '' ? loaded.matchedPreset : name);
    let updated: Form = { ...form, preset: name };
    for (const field of FIELDS) {
      if (!isChanged(field)) updated = withValue(updated, field, next);
    }
    change(updated, 'preset');
  };

  const save = (event: SyntheticEvent): void => {
    event.preventDefault();
    const found: Partial<Record<string, string>> = {};
    const overrides: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const parsed = parseField(field, form);
      if (!parsed.ok) found[field] = parsed.error;
      else if (isChanged(field)) overrides[field] = parsed.value;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setNotice({ kind: 'alert', text: 'Some fields need fixing.' });
      return;
    }
    api
      .saveModelProfile({
        preset: form.preset === '' ? null : form.preset,
        overrides,
      })
      .then(
        (view) => {
          show(view);
          setNotice({
            kind: 'status',
            text: 'Profile saved. It applies from the next reply.',
          });
        },
        (reason: unknown) => {
          if (reason instanceof FieldError) {
            setErrors({ [reason.field]: reason.message });
          }
          setNotice({ kind: 'alert', text: errorMessage(reason) });
        },
      );
  };

  const resetAll = (): void => {
    api.resetModelProfile().then(
      (view) => {
        show(view);
        setNotice({
          kind: 'status',
          text: 'Every change to this model’s profile was reset.',
        });
      },
      (reason: unknown) => {
        setNotice({ kind: 'alert', text: errorMessage(reason) });
      },
    );
  };

  const reset = (field: ProfileField) => () => {
    change(withValue(form, field, preset), field);
  };

  return (
    <form className="form profile-editor" onSubmit={save} noValidate>
      <p>
        <strong>Loaded model:</strong>{' '}
        <span data-testid="profile-model">{loaded.model}</span>
      </p>
      <p className="hint">
        Each model KoboldCpp loads gets a preset, which matches its name, with
        your changes on top. Only this model’s profile is edited here; a change
        applies from the next reply.
      </p>

      <Field
        label="Preset"
        hint={`This model’s name matches ${loaded.matchedPreset}. Choose another preset for a model whose name matches none that suits it.`}
        changed={form.preset !== ''}
        onReset={() => {
          choosePreset('');
        }}
        error={errors.preset}
      >
        {(props) => (
          <select
            {...props}
            value={form.preset}
            onChange={(event) => {
              choosePreset(event.target.value);
            }}
          >
            <option value="">{loaded.matchedPreset} (matched)</option>
            {loaded.presets
              .filter(({ name }) => name !== loaded.matchedPreset)
              .map(({ name }) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        )}
      </Field>

      {NUMBERS.map(({ field, label, hint }) => (
        <Field
          key={field}
          label={label}
          hint={
            field === 'contextLength'
              ? `${hint} KoboldCpp’s: ${loaded.contextLength.toLocaleString('en')}.`
              : hint
          }
          changed={isChanged(field)}
          onReset={reset(field)}
          error={errors[field]}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              inputMode="decimal"
              value={form.numbers[field]}
              onChange={(event) => {
                change(
                  {
                    ...form,
                    numbers: { ...form.numbers, [field]: event.target.value },
                  },
                  field,
                );
              }}
            />
          )}
        </Field>
      ))}

      <Field
        label="Stop sequences"
        hint="The reply ends where the model writes one of these. Write a new line as \n. {user} and {character} are filled in with the names."
        changed={isChanged('stop')}
        onReset={reset('stop')}
        error={errors.stop}
      >
        {(props) => (
          <div className="stop-list">
            {form.stop.map((stop, index) => (
              <div className="stop-row" key={index}>
                <input
                  type="text"
                  aria-label={`Stop sequence ${String(index + 1)}`}
                  {...(index === 0 && { id: props.id })}
                  value={stop}
                  onChange={(event) => {
                    const next = [...form.stop];
                    next[index] = event.target.value;
                    change({ ...form, stop: next }, 'stop');
                  }}
                />
                <button
                  type="button"
                  className="small"
                  aria-label={`Remove stop sequence ${String(index + 1)}`}
                  onClick={() => {
                    change(
                      {
                        ...form,
                        stop: form.stop.filter((_, at) => at !== index),
                      },
                      'stop',
                    );
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="small"
                {...(form.stop.length === 0 && { id: props.id })}
                onClick={() => {
                  change({ ...form, stop: [...form.stop, ''] }, 'stop');
                }}
              >
                Add stop sequence
              </button>
            </div>
          </div>
        )}
      </Field>

      <Field
        label="Instructions"
        hint="Where the character’s instructions go. Use the first user message for a chat template with no system role."
        changed={isChanged('systemRole')}
        onReset={reset('systemRole')}
        error={errors.systemRole}
      >
        {(props) => (
          <select
            {...props}
            value={form.systemRole}
            onChange={(event) => {
              change(
                {
                  ...form,
                  systemRole: event.target.value as ModelProfile['systemRole'],
                },
                'systemRole',
              );
            }}
          >
            <option value="system">As a system message</option>
            <option value="merge-into-first-user">
              In the first user message
            </option>
          </select>
        )}
      </Field>

      <Field
        label="Thinking"
        hint="For a thinking model: drop what it writes between the tags at the start of a reply."
        changed={isChanged('thinking')}
        onReset={reset('thinking')}
        error={errors.thinking}
      >
        {(props) => (
          <>
            <select
              {...props}
              value={form.thinkingMode}
              onChange={(event) => {
                change(
                  {
                    ...form,
                    thinkingMode: event.target.value as Form['thinkingMode'],
                  },
                  'thinking',
                );
              }}
            >
              <option value="none">
                None: the reply is passed on as it is
              </option>
              <option value="strip">Strip: drop thinking between tags</option>
            </select>
            {form.thinkingMode === 'strip' && (
              <div className="tag-row">
                <label>
                  Open tag
                  <input
                    type="text"
                    value={form.open}
                    onChange={(event) => {
                      change({ ...form, open: event.target.value }, 'thinking');
                    }}
                  />
                </label>
                <label>
                  Close tag
                  <input
                    type="text"
                    value={form.close}
                    onChange={(event) => {
                      change(
                        { ...form, close: event.target.value },
                        'thinking',
                      );
                    }}
                  />
                </label>
              </div>
            )}
          </>
        )}
      </Field>

      <Field
        label="Extra request fields (JSON)"
        hint='A JSON object merged into every request, for KoboldCpp fields chatThree does not know, such as {"reasoning_effort": "none"}. It cannot change the model, the messages, streaming or the response format.'
        changed={isChanged('extraBody')}
        onReset={reset('extraBody')}
        error={errors.extraBody}
      >
        {(props) => (
          <textarea
            {...props}
            rows={4}
            spellCheck={false}
            value={form.extraBody}
            onChange={(event) => {
              change({ ...form, extraBody: event.target.value }, 'extraBody');
            }}
          />
        )}
      </Field>

      <div className="form-actions">
        <button type="submit" className="primary">
          Save profile
        </button>
        <button
          type="button"
          disabled={!loaded.presetChosen && loaded.overridden.length === 0}
          onClick={resetAll}
        >
          Reset all
        </button>
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
  );
}
