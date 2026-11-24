import { useId } from 'react';

/**
 * A labelled text input with an optional hint. With `rows` it is a
 * multi-line box. The hint describes the field without being part of its name.
 */
export function TextField({
  label,
  hint,
  value,
  onChange,
  rows,
  required = false,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const described =
    hint === undefined ? {} : { 'aria-describedby': `${id}-hint` };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {rows === undefined ? (
        <input
          id={id}
          type="text"
          required={required}
          maxLength={maxLength}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          {...described}
        />
      ) : (
        <textarea
          id={id}
          rows={rows}
          required={required}
          maxLength={maxLength}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          {...described}
        />
      )}
      {hint !== undefined && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
