// Probes a real KoboldCpp server and writes what it does to a Markdown report,
// with every request and response. It answers the questions in issue #33,
// which the KoboldCpp text backend is built on.
//
//   node scripts/koboldcpp-probe.ts --url http://192.168.1.50:5001
//     [--password secret] [--out folder] [--only 1,5,9]
//
// It sends real generations, some of them long, and one test (11) fills most
// of the model's context several times: a full run takes minutes.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SCENE_SCHEMA } from '../src/server/scene/describe.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    password: { type: 'string' },
    out: { type: 'string', default: '.' },
    only: { type: 'string' },
  },
});

if (args.url === undefined) {
  console.error(
    'Usage: node scripts/koboldcpp-probe.ts --url http://host:5001 [--password secret] [--out folder] [--only 1,5,9]',
  );
  process.exit(2);
}
const base = args.url.replace(/\/+$/, '');
const password = args.password;
const only =
  args.only === undefined
    ? undefined
    : new Set(args.only.split(',').map((s) => Number(s.trim())));

// ---------------------------------------------------------------- the report

const report: string[] = [];
const MAX_SHOWN = 2500;

function say(markdown: string): void {
  report.push(markdown, '');
}

function finding(text: string): void {
  say(`> **Finding:** ${text}`);
  console.log(`  -> ${text}`);
}

function shown(text: string): string {
  return text.length <= MAX_SHOWN
    ? text
    : `${text.slice(0, MAX_SHOWN)}\n… (${String(text.length - MAX_SHOWN)} more characters)`;
}

function block(label: string, text: string, lang = ''): void {
  say(`${label}\n\n\`\`\`${lang}\n${shown(text)}\n\`\`\``);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ------------------------------------------------------------------ requests

type Auth = 'default' | 'none' | { bearer: string };

function headers(auth: Auth, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const key =
    auth === 'default' ? password : auth === 'none' ? undefined : auth.bearer;
  if (key !== undefined) h.Authorization = `Bearer ${key}`;
  return h;
}

interface Reply {
  status: number;
  text: string;
  json: unknown;
  ms: number;
}

/** One plain request, recorded in the report unless `quiet`. */
async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts: { auth?: Auth; quiet?: boolean; showBody?: unknown } = {},
): Promise<Reply> {
  const started = performance.now();
  let status = 0;
  let text: string;
  try {
    const response = await fetch(base + path, {
      method,
      headers: headers(opts.auth ?? 'default', body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    text = `(request failed: ${describeError(error)})`;
  }
  const ms = Math.round(performance.now() - started);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (opts.quiet !== true) {
    const authNote =
      opts.auth === undefined || opts.auth === 'default'
        ? ''
        : opts.auth === 'none'
          ? ' (no Authorization header)'
          : ' (Authorization: Bearer <given value>)';
    const shownBody = opts.showBody ?? body;
    say(
      `**${method} ${path}**${authNote}` +
        (shownBody === undefined
          ? ''
          : `\n\n\`\`\`json\n${shown(pretty(shownBody))}\n\`\`\``),
    );
    block(
      `→ ${String(status)} in ${String(ms)} ms`,
      json === undefined ? text : pretty(json),
      json === undefined ? '' : 'json',
    );
  }
  return { status, text, json, ms };
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.name}: ${error.message}${cause}`;
}

/** `value[k1][k2]…`, or `undefined` where the path is missing. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

interface StreamResult {
  status: number;
  /** The body of a refused request. */
  errorBody: string;
  rawLines: string[];
  content: string;
  finishReasons: string[];
  /** Fields seen in `delta`, beyond `role` and `content`, with their text. */
  otherDelta: Map<string, string>;
  /** Fields seen on a choice or the chunk, apart from the usual ones. */
  otherKeys: Set<string>;
  firstTokenMs: number | undefined;
  totalMs: number;
  aborted: boolean;
}

/**
 * One streamed chat completion. `onChunk` is called after every chunk with
 * how many have arrived and may abort the request.
 */
async function stream(
  body: Record<string, unknown>,
  opts: {
    onChunk?: (count: number, abort: () => void) => void | Promise<void>;
    auth?: Auth;
  } = {},
): Promise<StreamResult> {
  const controller = new AbortController();
  const started = performance.now();
  const result: StreamResult = {
    status: 0,
    errorBody: '',
    rawLines: [],
    content: '',
    finishReasons: [],
    otherDelta: new Map(),
    otherKeys: new Set(),
    firstTokenMs: undefined,
    totalMs: 0,
    aborted: false,
  };
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(opts.auth ?? 'default', true),
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
    result.status = response.status;
    if (!response.ok || response.body === null) {
      result.errorBody = await response.text();
      result.totalMs = Math.round(performance.now() - started);
      return result;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let chunks = 0;
    for await (const piece of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        result.rawLines.push(line);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        readChunk(event, result, started);
        chunks += 1;
        await opts.onChunk?.(chunks, () => {
          result.aborted = true;
          controller.abort();
        });
      }
    }
  } catch (error) {
    if (!result.aborted) result.errorBody = describeError(error);
  }
  result.totalMs = Math.round(performance.now() - started);
  return result;
}

const USUAL_CHUNK_KEYS = new Set([
  'id',
  'object',
  'created',
  'model',
  'choices',
  'system_fingerprint',
]);
const USUAL_CHOICE_KEYS = new Set([
  'index',
  'delta',
  'finish_reason',
  'logprobs',
]);

function readChunk(event: unknown, result: StreamResult, started: number) {
  if (typeof event !== 'object' || event === null) return;
  for (const key of Object.keys(event)) {
    if (!USUAL_CHUNK_KEYS.has(key)) result.otherKeys.add(`chunk.${key}`);
  }
  const choice = at(event, 'choices', 0);
  if (typeof choice !== 'object' || choice === null) return;
  for (const key of Object.keys(choice)) {
    if (!USUAL_CHOICE_KEYS.has(key)) result.otherKeys.add(`choice.${key}`);
  }
  const finish = at(choice, 'finish_reason');
  if (typeof finish === 'string') result.finishReasons.push(finish);
  const delta = at(choice, 'delta');
  if (typeof delta !== 'object' || delta === null) return;
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'role') continue;
    if (key === 'content') {
      if (typeof value === 'string' && value !== '') {
        result.firstTokenMs ??= Math.round(performance.now() - started);
        result.content += value;
      }
      continue;
    }
    const text =
      typeof value === 'string' ? value : value === null ? '' : pretty(value);
    result.otherDelta.set(key, (result.otherDelta.get(key) ?? '') + text);
    if (text !== '')
      result.firstTokenMs ??= Math.round(performance.now() - started);
  }
}

function reportStream(label: string, body: unknown, r: StreamResult): void {
  say(`**POST /v1/chat/completions** (${label})`);
  block('Request body', pretty(body), 'json');
  if (r.status !== 200 || r.errorBody !== '') {
    block(`→ ${String(r.status)}`, r.errorBody);
  }
  const first = r.rawLines.slice(0, 6);
  const last = r.rawLines.length > 10 ? r.rawLines.slice(-4) : [];
  const rest = r.rawLines.length > 10 ? r.rawLines.length - 10 : 0;
  block(
    `→ ${String(r.status)}: ${String(r.rawLines.length)} lines, first token ${
      r.firstTokenMs === undefined ? 'never' : `${String(r.firstTokenMs)} ms`
    }, ${String(r.totalMs)} ms in all${r.aborted ? ', aborted by the probe' : ''}. Raw lines:`,
    [
      ...r.rawLines.slice(0, r.rawLines.length > 10 ? 6 : 10),
      ...(rest > 0 ? [`… ${String(rest)} lines …`] : []),
      ...last,
    ].join('\n') || '(none)',
  );
  if (first.length === 0 && r.errorBody === '') say('(no lines)');
  block('Content', r.content === '' ? '(empty)' : r.content);
  say(
    `finish_reason values: ${r.finishReasons.length === 0 ? 'none' : r.finishReasons.map((f) => `\`${f}\``).join(', ')}`,
  );
  for (const [key, text] of r.otherDelta) {
    block(`Other field in delta: \`${key}\``, text === '' ? '(empty)' : text);
  }
  if (r.otherKeys.size > 0) {
    say(
      `Other fields on chunks: ${[...r.otherKeys].map((k) => `\`${k}\``).join(', ')}`,
    );
  }
}

/** A non-streamed chat completion's text, recorded quietly. */
async function complete(body: Record<string, unknown>): Promise<string> {
  const r = await call('POST', '/v1/chat/completions', body, { quiet: true });
  const content = at(r.json, 'choices', 0, 'message', 'content');
  return typeof content === 'string'
    ? content
    : `(${String(r.status)}) ${r.text}`;
}

function user(content: string) {
  return [{ role: 'user', content }];
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ------------------------------------------------------------- filler text

const WORDS =
  'harbour lantern storm gull rope tide salt cliff keeper beacon fog oar net shingle squall anchor driftwood kelp ledger candle hull mast cabin pier smoke ember quay brine wave shutter bell chart compass rain gale moss stone path cottage widow sailor letter secret map ink boot cloak window hearth kettle bread fish crate barrel tar lamp signal wreck reef channel current moon star dusk dawn'.split(
    ' ',
  );

/** Varied, repeatable prose of about `chars` characters. */
function filler(seed: number, chars: number): string {
  let state = seed * 9301 + 49297;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  const sentences: string[] = [];
  let length = 0;
  while (length < chars) {
    const count = 8 + (next() % 10);
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      words.push(WORDS[next() % WORDS.length] ?? 'sea');
    }
    const sentence = `${words.join(' ')} ${String(next() % 1000)}.`;
    sentences.push(sentence.charAt(0).toUpperCase() + sentence.slice(1));
    length += sentence.length + 1;
  }
  return sentences.join(' ');
}

// -------------------------------------------------------------- the checks

let modelId = 'unknown-model';
let contextLength = 4096;

async function check1(): Promise<void> {
  const r = await call('GET', '/api/extra/version');
  const version = at(r.json, 'version');
  finding(
    `KoboldCpp ${typeof version === 'string' ? version : '(version not reported)'}; protected: ${pretty(at(r.json, 'protected'))}`,
  );
}

async function check2(): Promise<void> {
  const models = await call('GET', '/v1/models');
  const kobold = await call('GET', '/api/v1/model');
  const id = at(models.json, 'data', 0, 'id');
  const name = at(kobold.json, 'result');
  if (typeof id === 'string') modelId = id;
  finding(
    `/v1/models id: \`${String(id)}\`; /api/v1/model result: \`${String(name)}\` (${id === name ? 'the same' : 'different'}). Compare with the GGUF file name and quantisation loaded.`,
  );
}

async function check3(): Promise<void> {
  const r = await call('GET', '/api/extra/true_max_context_length');
  await call('GET', '/api/v1/config/max_context_length');
  const value = at(r.json, 'value');
  if (typeof value === 'number') contextLength = value;
  finding(
    `true_max_context_length: ${String(value)}. Compare with the --contextsize KoboldCpp was started with.`,
  );
}

async function check4(): Promise<void> {
  const small = await call('POST', '/api/extra/tokencount', {
    prompt: 'Hello there, how are you today?',
  });
  const big = filler(4, 64_000);
  const times: number[] = [];
  let count: unknown;
  for (let i = 0; i < 3; i++) {
    const r = await call(
      'POST',
      '/api/extra/tokencount',
      { prompt: big },
      i === 0
        ? {
            showBody: { prompt: `(${String(big.length)} characters of prose)` },
          }
        : { quiet: true },
    );
    times.push(r.ms);
    count = at(r.json, 'value');
  }
  finding(
    `tokencount works: ${small.status === 200 ? 'yes' : `no (${String(small.status)})`}. ${String(big.length)} characters = ${String(count)} tokens (${(big.length / Number(count)).toFixed(2)} characters per token), timed ${times.map((t) => `${String(t)} ms`).join(', ')}.`,
  );
}

async function check5(): Promise<void> {
  const plain = {
    messages: user('Count from 1 to 5, as digits separated by spaces.'),
    max_tokens: 100,
    temperature: 0.2,
  };
  const r1 = await stream(plain);
  reportStream('ends by itself', plain, r1);

  const short = { ...plain, max_tokens: 3 };
  const r2 = await stream(short);
  reportStream('cut off by max_tokens', short, r2);

  const stopped = {
    messages: user('Count from 1 to 10, as digits separated by spaces.'),
    max_tokens: 100,
    temperature: 0.2,
    stop: ['6'],
  };
  const r3 = await stream(stopped);
  reportStream('stop sequence "6"', stopped, r3);

  const nonStream = await call('POST', '/v1/chat/completions', plain);
  finding(
    `finish_reason: natural end ${JSON.stringify(r1.finishReasons)}, max_tokens ${JSON.stringify(r2.finishReasons)}, stop ${JSON.stringify(r3.finishReasons)}; content after the stop: ${JSON.stringify(r3.content)} (${r3.content.includes('6') ? 'includes' : 'excludes'} the stop text). Non-streamed usage: ${JSON.stringify(at(nonStream.json, 'usage'))}`,
  );
}

async function distinct(
  body: Record<string, unknown>,
  runs: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < runs; i++) out.push((await complete(body)).trim());
  return out;
}

async function check6(): Promise<void> {
  const wordPrompt = {
    messages: user(
      'Write one unusual English word chosen at random. Only the word.',
    ),
    max_tokens: 12,
    temperature: 2.0,
  };
  const rows: [string, Record<string, unknown>][] = [
    ['temperature 2 only', {}],
    ['top_k 1', { top_k: 1 }],
    ['min_p 1.0', { min_p: 1.0 }],
  ];
  say(
    'Each row: 5 runs at temperature 2. With top_k 1 or min_p 1 taking effect, the runs come out identical.',
  );
  const lines: string[] = [];
  for (const [label, extra] of rows) {
    const out = await distinct({ ...wordPrompt, ...extra }, 5);
    lines.push(
      `| ${label} | ${String(new Set(out).size)} | ${out.map((o) => `\`${o.replace(/\|/g, '/').replace(/\n/g, ' ')}\``).join(' ')} |`,
    );
  }
  say(['| Body | Distinct | Answers |', '|---|---|---|', ...lines].join('\n'));

  const repeatPrompt = {
    messages: user(
      'Write the word "apple" 30 times, separated by spaces. Nothing else.',
    ),
    max_tokens: 120,
    temperature: 0.01,
  };
  const reps: [string, Record<string, unknown>][] = [
    ['no penalty', {}],
    ['rep_pen 3', { rep_pen: 3 }],
    ['rep_pen 3, rep_pen_range 1', { rep_pen: 3, rep_pen_range: 1 }],
    ['repetition_penalty 3 (OpenAI-style name)', { repetition_penalty: 3 }],
  ];
  say(
    'Repetition: how many times "apple" is written. rep_pen 3 taking effect cuts it down; rep_pen_range 1 then limits the penalty to the last token, which should bring the apples back.',
  );
  const repLines: string[] = [];
  for (const [label, extra] of reps) {
    const text = await complete({ ...repeatPrompt, ...extra });
    const apples = (text.match(/apple/gi) ?? []).length;
    repLines.push(
      `| ${label} | ${String(apples)} | \`${text.slice(0, 120).replace(/\n/g, ' ')}\` |`,
    );
  }
  say(['| Body | apples | Text |', '|---|---|---|', ...repLines].join('\n'));
  finding(
    'See the two tables: identical runs mean top_k / min_p took effect; fewer apples mean rep_pen did. stop is covered by check 5.',
  );
}

async function check7(): Promise<void> {
  const french = {
    messages: [
      {
        role: 'system',
        content:
          'You reply only in French, whatever language the user writes in.',
      },
      ...user('What colour is the sky on a clear day? One sentence.'),
    ],
    max_tokens: 80,
    temperature: 0.01,
  };
  const r1 = await call('POST', '/v1/chat/completions', french);
  const named = {
    messages: [
      {
        role: 'system',
        content: 'Your name is Zorblax. You always say your name when asked.',
      },
      ...user('What is your name? One short sentence.'),
    ],
    max_tokens: 60,
    temperature: 0.01,
  };
  const r2 = await call('POST', '/v1/chat/completions', named);
  finding(
    `French system message → ${JSON.stringify(at(r1.json, 'choices', 0, 'message', 'content'))}; Zorblax system message → ${JSON.stringify(at(r2.json, 'choices', 0, 'message', 'content'))}. French and "Zorblax" mean the system message was honoured.`,
  );
}

type Schema = Record<string, unknown>;

/** GBNF for the subset of JSON Schema that SCENE_SCHEMA uses. */
function gbnf(schema: Schema): string {
  const rules: string[] = [];
  let counter = 0;
  const rule = (s: Schema): string => {
    if (s.type === 'string') return 'string';
    if (s.type === 'boolean') return 'boolean';
    const name = `obj${String(counter++)}`;
    const props = Object.entries(s.properties as Record<string, Schema>);
    const parts = props.map(
      ([key, value], i) =>
        `${i === 0 ? '' : '"," ws '}"\\"${key}\\"" ws ":" ws ${rule(value)} ws`,
    );
    rules.push(`${name} ::= "{" ws ${parts.join(' ')} "}"`);
    return name;
  };
  const root = rule(schema);
  return [
    `root ::= ws ${root} ws`,
    ...rules,
    'string ::= "\\"" ([^"\\\\\\n] | "\\\\" ["\\\\/bfnrt])* "\\""',
    'boolean ::= "true" | "false"',
    'ws ::= [ \\t\\n]*',
  ].join('\n');
}

/** What is wrong with `value` against the SCENE_SCHEMA subset, if anything. */
function schemaErrors(value: unknown, schema: Schema, path = '$'): string[] {
  if (schema.type === 'string')
    return typeof value === 'string' ? [] : [`${path} is not a string`];
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? [] : [`${path} is not a boolean`];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return [`${path} is not an object`];
  const props = schema.properties as Record<string, Schema>;
  const errors: string[] = [];
  for (const [key, sub] of Object.entries(props)) {
    if (!(key in value)) errors.push(`${path}.${key} is missing`);
    else
      errors.push(
        ...schemaErrors(
          (value as Record<string, unknown>)[key],
          sub,
          `${path}.${key}`,
        ),
      );
  }
  for (const key of Object.keys(value)) {
    if (!(key in props)) errors.push(`${path}.${key} is not in the schema`);
  }
  return errors;
}

function judge(content: string): string {
  try {
    const errors = schemaErrors(JSON.parse(content), SCENE_SCHEMA);
    return errors.length === 0
      ? 'valid JSON that follows the schema'
      : `valid JSON, but ${errors.join('; ')}`;
  } catch {
    return 'not JSON on its own';
  }
}

async function check8(): Promise<void> {
  const messages = [
    {
      role: 'system',
      content:
        'You describe a moment in a story for an illustrator. The known places are: "The Lighthouse".',
    },
    ...user(
      'Current place: The Lighthouse.\n\nMara: *She climbs the last of the spiral stairs, lantern shaking in her hand, and stares out at the storm rolling over the harbour.* "It is coming in faster than I thought."\n\nDescribe this moment.',
    ),
  ];
  const common = { messages, max_tokens: 600, temperature: 0.3 };
  const grammar = gbnf(SCENE_SCHEMA);
  const variants: [string, Record<string, unknown>][] = [
    ['no constraint', {}],
    [
      'response_format json_schema',
      {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'scene', strict: true, schema: SCENE_SCHEMA },
        },
      },
    ],
    [
      'response_format json_object',
      { response_format: { type: 'json_object' } },
    ],
    ['grammar (GBNF from the scene schema)', { grammar }],
  ];
  const results: string[] = [];
  for (const [label, extra] of variants) {
    say(`### 8: ${label}`);
    const body = { ...common, ...extra };
    const r = await call('POST', '/v1/chat/completions', body, {
      showBody:
        'grammar' in extra ? { ...common, grammar: '(the GBNF below)' } : body,
    });
    const content = at(r.json, 'choices', 0, 'message', 'content');
    const verdict =
      typeof content === 'string' ? judge(content.trim()) : 'no content';
    results.push(`${label}: ${verdict} (${String(r.ms)} ms)`);
  }
  block('The GBNF sent', grammar);

  const tiny = {
    messages: user('Write a short poem about the sea.'),
    max_tokens: 20,
    grammar: 'root ::= "yes" | "no"',
  };
  const t = await call('POST', '/v1/chat/completions', tiny);
  results.push(
    `grammar \`root ::= "yes" | "no"\` on a poem request → ${JSON.stringify(at(t.json, 'choices', 0, 'message', 'content'))}`,
  );
  finding(results.join('. '));
}

async function perf(label: string): Promise<unknown> {
  const r = await call('GET', '/api/extra/perf', undefined, { quiet: true });
  const p = r.json;
  console.log(
    `  perf ${label}: idle=${pretty(at(p, 'idle'))} queue=${pretty(at(p, 'queue'))}`,
  );
  return p;
}

async function generatingText(): Promise<string> {
  const r = await call(
    'POST',
    '/api/extra/generate/check',
    {},
    { quiet: true },
  );
  const text = at(r.json, 'results', 0, 'text');
  return typeof text === 'string' ? text : '';
}

/** Polls whether KoboldCpp is still generating, for `ms`. */
async function watch(label: string, ms: number): Promise<string[]> {
  const lines: string[] = [];
  const started = performance.now();
  while (performance.now() - started < ms) {
    const p = await perf(label);
    const partial = await generatingText();
    lines.push(
      `+${String(Math.round(performance.now() - started))} ms: idle=${pretty(at(p, 'idle'))} queue=${pretty(at(p, 'queue'))} generate/check length=${String(partial.length)}`,
    );
    await sleep(700);
  }
  return lines;
}

const LONG_STORY = {
  messages: user(
    'Write a very long story, at least 3000 words, about a lighthouse keeper and a storm. Do not stop early.',
  ),
  max_tokens: 2000,
  temperature: 0.8,
};

async function check9(): Promise<void> {
  console.log(
    "  Watch the KoboldCpp console and the other PC's GPU load during this check.",
  );
  say(
    'While this ran, the KoboldCpp console and GPU load were to be watched for the generation stopping.',
  );
  await call('GET', '/api/extra/perf');

  say('### 9a: closing the connection mid-stream');
  const a = await stream(LONG_STORY, {
    onChunk: (n, abort) => {
      if (n === 30) abort();
    },
  });
  reportStream('connection closed after 30 chunks', LONG_STORY, a);
  const afterClose = await watch('after close', 6000);
  block(
    'Polled after closing (perf and generate/check)',
    afterClose.join('\n'),
  );
  await call('POST', '/api/extra/abort', {});
  await sleep(1000);

  say('### 9b: POST /api/extra/abort without a genkey');
  let abortReply: Reply | undefined;
  const b = await stream(LONG_STORY, {
    onChunk: async (n) => {
      if (n === 30) abortReply = await call('POST', '/api/extra/abort', {});
    },
  });
  reportStream('abort called after 30 chunks', LONG_STORY, b);
  await sleep(1000);

  say('### 9c: POST /api/extra/abort with a genkey that matches nothing');
  const c = await stream(LONG_STORY, {
    onChunk: async (n) => {
      if (n === 30)
        await call('POST', '/api/extra/abort', {
          genkey: 'KCPP-PROBE-NOMATCH',
        });
    },
  });
  reportStream('abort with a wrong genkey after 30 chunks', LONG_STORY, c);
  await call('POST', '/api/extra/abort', {});
  await sleep(1000);

  say('### 9d: a second request while one is generating');
  let second: Reply | undefined;
  const second_body = {
    messages: user('Say hello.'),
    max_tokens: 10,
  };
  const d = await stream(LONG_STORY, {
    onChunk: async (n, abort) => {
      if (n === 10) {
        second = await call('POST', '/v1/chat/completions', second_body);
        abort();
      }
    },
  });
  reportStream(
    'first request, aborted once the second returned',
    LONG_STORY,
    d,
  );
  await call('POST', '/api/extra/abort', {});

  const chunksAfter = (r: StreamResult) =>
    r.rawLines.filter((l) => l.startsWith('data:')).length;
  finding(
    [
      `After closing the connection: ${afterClose.at(-1) ?? '?'} (idle 1 and a generate/check length that stops growing mean it stopped)`,
      `abort without genkey → ${String(abortReply?.status)} ${abortReply?.text.trim() ?? ''}; the stream then ended with ${String(chunksAfter(b))} data lines and finish_reason ${JSON.stringify(b.finishReasons)} after ${String(b.totalMs)} ms`,
      `abort with a wrong genkey: stream ended with ${String(chunksAfter(c))} data lines (about 30 means it stopped anyway; ~2000 means the genkey mattered)`,
      `a second request while generating → ${String(second?.status)} after ${String(second?.ms)} ms: ${second?.text.slice(0, 300) ?? ''}`,
    ].join('. '),
  );
}

async function check10(): Promise<void> {
  const question = 'What is 17 times 23? Answer briefly.';
  const variants: [string, Record<string, unknown>][] = [
    ['as is', { messages: user(question) }],
    ['"/no_think" in the message', { messages: user(`${question} /no_think`) }],
    [
      'chat_template_kwargs.enable_thinking false',
      {
        messages: user(question),
        chat_template_kwargs: { enable_thinking: false },
      },
    ],
    [
      'reasoning_effort "none"',
      { messages: user(question), reasoning_effort: 'none' },
    ],
  ];
  const lines: string[] = [];
  for (const [label, extra] of variants) {
    const body = { max_tokens: 1500, temperature: 0.6, ...extra };
    const r = await stream(body);
    reportStream(label, body, r);
    const tags = /<think>|<\/think>/.exec(r.content)?.[0];
    lines.push(
      `${label}: think tag in content ${tags === undefined ? 'no' : 'yes'}; other delta fields ${[...r.otherDelta.keys()].join(', ') || 'none'}; ${String(r.content.length)} characters`,
    );
  }
  finding(lines.join('. '));
}

async function check11(): Promise<void> {
  const system = `You are Mara Quill, a lighthouse keeper. ${filler(1, 1200)}`;
  const sample = filler(2, 1000);
  const counted = at(
    (
      await call(
        'POST',
        '/api/extra/tokencount',
        { prompt: sample },
        { quiet: true },
      )
    ).json,
    'value',
  );
  const perMessage = typeof counted === 'number' && counted > 0 ? counted : 250;
  const target = Math.floor(contextLength * 0.7);
  const n = Math.max(4, Math.floor(target / (perMessage + 8)));
  const messages = Array.from({ length: n + 6 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: filler(100 + i, 1000),
  }));
  say(
    `Context ${String(contextLength)} tokens; ${String(n)} messages of about ${String(perMessage)} tokens fill about 70% of it. Each turn asks for 8 tokens. Watch the KoboldCpp console for ContextShift / FastForward / "Processing Prompt".`,
  );
  const turns: [string, number, number][] = [
    ['turn 1 (cold)', 0, n],
    ['turn 2 (oldest dropped)', 1, n + 1],
    ['turn 3 (oldest dropped)', 2, n + 2],
    ['turn 4 (oldest dropped)', 3, n + 3],
    ['turn 5 (only appended, nothing dropped)', 3, n + 5],
    ['turn 6 (the same prompt again)', 3, n + 5],
  ];
  const rows: string[] = [];
  for (const [label, from, to] of turns) {
    let window = messages.slice(from, to);
    // The conversation must end with the user's message.
    if (window.at(-1)?.role !== 'user') window = window.slice(0, -1);
    console.log(`  ${label}: messages ${String(from)}..${String(to)}`);
    const r = await stream({
      messages: [{ role: 'system', content: system }, ...window],
      max_tokens: 8,
      temperature: 0.7,
    });
    const p = await perf(label);
    rows.push(
      `| ${label} | ${String(window.length)} | ${String(r.firstTokenMs)} | ${pretty(at(p, 'last_process'))} | ${pretty(at(p, 'last_input_count'))} | ${r.status === 200 ? '' : `${String(r.status)} ${r.errorBody.slice(0, 120)}`} |`,
    );
  }
  say(
    [
      '| Turn | Messages | First token (ms) | perf.last_process (s) | perf.last_input_count | Error |',
      '|---|---|---|---|---|---|',
      ...rows,
    ].join('\n'),
  );
  finding(
    'Turns 2–4 near turn 1 mean the whole prompt is processed again when the oldest message drops; near turns 5–6 mean the cache was reused. Note what the console printed.',
  );
}

async function check12(): Promise<void> {
  if (password === undefined) {
    const r = await call('GET', '/api/extra/version', undefined, {
      quiet: true,
    });
    finding(
      `No --password given to the probe; the server reports protected: ${pretty(at(r.json, 'protected'))}. Run again against a server started with --password to check this.`,
    );
    return;
  }
  const body = { messages: user('Say hi.'), max_tokens: 5 };
  const lines: string[] = [];
  for (const [label, auth] of [
    ['none', 'none'],
    ['wrong', { bearer: 'not-the-password' }],
    ['right', 'default'],
  ] as const) {
    const v = await call('GET', '/api/extra/version', undefined, { auth });
    const m = await call('GET', '/v1/models', undefined, { auth });
    const c = await call('POST', '/v1/chat/completions', body, { auth });
    lines.push(
      `${label} password: version ${String(v.status)}, /v1/models ${String(m.status)}, chat ${String(c.status)}`,
    );
  }
  const raw = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: password },
    body: JSON.stringify(body),
  });
  lines.push(`password without "Bearer ": chat ${String(raw.status)}`);
  await raw.text();
  finding(lines.join('; '));
}

// ------------------------------------------------------------------- run

const checks: [number, string, () => Promise<void>][] = [
  [1, 'Version', check1],
  [2, 'Model identity', check2],
  [3, 'Context length', check3],
  [4, 'Token counting', check4],
  [5, 'Streaming chat completions', check5],
  [6, 'Extra sampler fields', check6],
  [7, 'System role', check7],
  [8, 'Structured output', check8],
  [9, 'Stopping', check9],
  [10, 'Thinking models', check10],
  [11, 'Prompt reprocessing', check11],
  [12, 'Password', check12],
];

const startedAt = new Date();
// Checks 2 and 3 set the model id and context length later checks use.
if (only !== undefined) {
  const quietReport = report.length;
  await check2();
  await check3();
  report.length = quietReport;
}
for (const [n, title, run] of checks) {
  if (only !== undefined && !only.has(n)) continue;
  console.log(`${String(n)}. ${title}`);
  say(`## ${String(n)}. ${title}`);
  try {
    await run();
  } catch (error) {
    finding(`the check failed: ${describeError(error)}`);
  }
}

const header = [
  `# KoboldCpp probe: ${modelId}`,
  '',
  `${base}, ${startedAt.toISOString()}, context ${String(contextLength)}${password === undefined ? '' : ', with a password'}.`,
  '',
];
const safeName = modelId.replace(/[^A-Za-z0-9._-]+/g, '_');
const file = resolve(
  join(
    args.out,
    `koboldcpp-probe-${safeName}-${startedAt.toISOString().replace(/[:.]/g, '-')}.md`,
  ),
);
writeFileSync(file, [...header, ...report].join('\n'));
console.log(`\nReport: ${file}`);
