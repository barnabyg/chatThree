// JSON answers from a model that is not held to a schema, or not reliably:
// finding the JSON in what it wrote, checking it against the schema, and
// describing the schema in words for the instructions.
//
// Only the part of JSON Schema that the app's own schemas use is understood:
// `type` (object, string, boolean, number, integer, array), `properties`,
// `required`, `additionalProperties: false`, `items`, `enum` and
// `description`.

/** A JSON Schema, as far as this file reads one. */
interface Schema {
  type?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly unknown[];
}

/** What a value is, in the words of JSON Schema's types. */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

/** An article and a type name, for error messages. */
function aType(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function check(
  value: unknown,
  schema: Schema,
  path: string,
  errors: string[],
): void {
  const where = path === '' ? 'the answer' : path;
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const matches =
      actual === schema.type ||
      (schema.type === 'number' && actual === 'integer');
    if (!matches) {
      errors.push(
        `${where} should be ${aType(schema.type)}, not ${aType(actual === 'integer' ? 'number' : actual)}`,
      );
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(
      `${where} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`,
    );
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!(name in object))
        errors.push(`${path === '' ? '' : `${path}.`}${name} is missing`);
    }
    for (const [name, field] of Object.entries(object)) {
      const fieldPath = path === '' ? name : `${path}.${name}`;
      const fieldSchema = properties[name];
      if (fieldSchema !== undefined)
        check(field, fieldSchema, fieldPath, errors);
      else if (schema.additionalProperties === false) {
        errors.push(`${fieldPath} is not one of the fields`);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      check(item, schema.items, `${where}[${String(index)}]`, errors);
    }
  }
}

/** How `value` fails to follow `schema`, in words: empty when it follows it. */
export function schemaErrors(value: unknown, schema: object): string[] {
  const errors: string[] = [];
  check(value, schema, '', errors);
  return errors;
}

/** `text` without a thinking model's `<think>…</think>`, or an unfinished one. */
function withoutThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '');
}

/** The end of the JSON object that starts at `start`, by counting braces, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The JSON object in a model's answer: the whole answer, or the first object
 * in it that parses, after any thinking. A model may put it in prose or a
 * code fence. `undefined` when there is none.
 */
export function findJson(text: string): { value: unknown } | undefined {
  const answer = withoutThinking(text).trim();
  const whole = parse(answer);
  if (whole !== undefined) return whole;
  for (
    let start = answer.indexOf('{');
    start !== -1;
    start = answer.indexOf('{', start + 1)
  ) {
    const end = objectEnd(answer, start);
    if (end === -1) continue;
    const found = parse(answer.slice(start, end + 1));
    if (found !== undefined) return found;
  }
  return undefined;
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  boolean: 'true or false',
  number: 'a number',
  integer: 'a whole number',
  array: 'a list',
  object: 'an object',
};

function describeFields(schema: Schema, path: string, lines: string[]): void {
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const fieldPath = path === '' ? name : `${path}.${name}`;
    const type = TYPE_WORDS[field.type ?? ''] ?? field.type ?? 'any value';
    lines.push(
      `- ${fieldPath} (${type})${field.description === undefined ? '' : `: ${field.description}`}`,
    );
    if (field.type === 'object') describeFields(field, fieldPath, lines);
  }
}

/** A value of the schema's shape, for an example. */
function example(schema: Schema): unknown {
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, field]) => [
          name,
          example(field),
        ]),
      );
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'array':
      return [];
    default:
      return schema.enum?.[0] ?? '…';
  }
}

/** The fields `schema` asks for, and an example of its shape, in words for a model. */
export function describeSchema(schema: object): string {
  const lines = ['Answer with a JSON object with these fields, all required:'];
  describeFields(schema, '', lines);
  return [
    lines.join('\n'),
    `Its shape:\n${JSON.stringify(example(schema), null, 2)}`,
  ].join('\n\n');
}
