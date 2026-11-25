// A stand-in for OpenAI's Responses API, so tests need no key and no network.
// It speaks the same streaming wire format as `POST /v1/responses`, checks the
// API key, and records every request so tests can see what was sent.
// A request that does not stream (`"stream": false`) asks for a structured
// answer, as the scene call does: those are answered and recorded apart from
// the replies, so that tests of either can count on their own. One that does
// not stream and asks for no format is a plain request, as the app makes to
// find out a model's thinking levels: those are recorded apart again.
//
// `GET /v1/models` lists `FAKE_MODELS`, and a request with a thinking level a
// model in `FAKE_REASONING` does not take is refused as OpenAI refuses it.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** The only key the fake accepts. Anything else gets OpenAI's 401. */
export const FAKE_API_KEY = 'sk-test-0000';

/** What `GET /v1/models` lists, as OpenAI does: in no useful order, chat models among others. */
export const FAKE_MODELS: readonly { id: string; created: number }[] = [
  { id: 'gpt-image-2', created: 1_776_000_000 },
  { id: 'gpt-4.1', created: 1_744_000_000 },
  { id: 'gpt-5.5', created: 1_776_800_000 },
  { id: 'gpt-5.5-2026-04-23', created: 1_776_800_000 },
  { id: 'gpt-5-mini', created: 1_754_000_000 },
  { id: 'tts-1', created: 1_681_000_000 },
  { id: 'text-embedding-3-small', created: 1_705_000_000 },
];

/** The thinking levels of the fake's models; `null` for one that does not think. Any other model takes any level. */
export const FAKE_REASONING: Readonly<Record<string, string[] | null>> = {
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
  'gpt-4.1': null,
};

/** OpenAI's refusal of `effort` for `model`, or `undefined` if the model takes it. */
function refuseEffort(model: string, effort: string): string | undefined {
  const supported = FAKE_REASONING[model];
  if (supported === null) {
    return "Unsupported parameter: 'reasoning.effort' is not supported with this model.";
  }
  if (supported === undefined || supported.includes(effort)) return undefined;
  const quoted = supported.map((level) => `'${level}'`);
  const list =
    quoted.length === 1
      ? quoted.join('')
      : `${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1) ?? ''}`;
  return `Unsupported value: '${effort}' is not supported with the '${model}' model. Supported values are: ${list}.`;
}

export type Behaviour =
  /**
   * Stream `chunks` as the reply, pausing `chunkDelayMs` before each. With
   * `holdAfter`, that many chunks are sent and the rest wait for `release()`,
   * so a test can look at a reply that is part-way through.
   */
  | {
      kind: 'reply';
      chunks: string[];
      chunkDelayMs?: number;
      holdAfter?: number;
    }
  /** The model declines to answer. */
  | { kind: 'refusal'; text: string }
  /** The request is rejected before any streaming starts. */
  | { kind: 'http-error'; status: number; message: string }
  /** The stream starts, then the connection drops. */
  | { kind: 'disconnect' };

/** How a structured (not streamed) request is answered. */
export type StructuredBehaviour =
  /** The model answers with `value`, as JSON. */
  | { kind: 'json'; value: unknown }
  /** The model answers with this text, which may not be JSON. */
  | { kind: 'text'; text: string }
  /** The model declines to answer. */
  | { kind: 'refusal'; text: string }
  /** The request is rejected. */
  | { kind: 'http-error'; status: number; message: string };

export interface RecordedRequest {
  body: {
    model: string;
    instructions: string;
    input: { role: string; content: string }[];
    stream: boolean;
    store: boolean;
  };
  /** True once the client has given up on the response before its end. */
  abandoned: boolean;
}

export interface FakeOpenAI {
  /** Use as `OPENAI_BASE_URL`. */
  baseUrl: string;
  /** Every authorised request received, oldest first. */
  requests: RecordedRequest[];
  /**
   * Set how the next requests are answered, one behaviour per request.
   * The last one repeats for every request after that.
   */
  respondWith(...behaviours: [Behaviour, ...Behaviour[]]): void;
  /** The bodies of every authorised structured request, oldest first. */
  structuredRequests: Record<string, unknown>[];
  /** The bodies of every authorised plain request, oldest first. */
  plainRequests: Record<string, unknown>[];
  /**
   * Set how the next structured requests are answered, as `respondWith` does
   * for replies. Until this is called, every one gets `DEFAULT_STRUCTURED`.
   */
  respondToStructuredWith(
    ...behaviours: [StructuredBehaviour, ...StructuredBehaviour[]]
  ): void;
  /** Let replies held by `holdAfter` carry on to their end. */
  release(): void;
  close(): Promise<void>;
}

const DEFAULT_REPLY: Behaviour = {
  kind: 'reply',
  chunks: ['Hello', ' from', ' the', ' fake', ' model.'],
};

/** A scene described as staying put, unremarkable: what a structured request gets by default. */
export const DEFAULT_SCENE = {
  action: 'Mara stands at the lamp-room window, looking out at the sea.',
  expression: 'calm and watchful',
  framing: 'medium shot',
  lighting: 'grey storm light',
  moved: false,
  location: { name: '', description: '' },
  worthIllustrating: false,
};

const DEFAULT_STRUCTURED: StructuredBehaviour = {
  kind: 'json',
  value: DEFAULT_SCENE,
};

/** A completed, non-streamed response whose one message holds `content`. */
function completed(content: object): object {
  return {
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [content] }],
  };
}

function answerStructured(
  behaviour: StructuredBehaviour,
  response: ServerResponse,
): void {
  if (behaviour.kind === 'http-error') {
    sendError(response, behaviour.status, behaviour.message);
    return;
  }
  const content =
    behaviour.kind === 'refusal'
      ? { type: 'refusal', refusal: behaviour.text }
      : {
          type: 'output_text',
          text:
            behaviour.kind === 'json'
              ? JSON.stringify(behaviour.value)
              : behaviour.text,
        };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(completed(content)));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

function sendEvent(response: ServerResponse, event: { type: string }): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sendError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message, type: 'fake_error' } }));
}

async function answer(
  behaviour: Behaviour,
  response: ServerResponse,
  released: Promise<void>,
): Promise<void> {
  if (behaviour.kind === 'http-error') {
    sendError(response, behaviour.status, behaviour.message);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendEvent(response, { type: 'response.created' });
  switch (behaviour.kind) {
    case 'reply':
      for (const [index, chunk] of behaviour.chunks.entries()) {
        if (index === behaviour.holdAfter) await released;
        if (behaviour.chunkDelayMs !== undefined) {
          await delay(behaviour.chunkDelayMs);
        }
        if (response.destroyed) return;
        sendEvent(response, {
          type: 'response.output_text.delta',
          delta: chunk,
        } as { type: string });
      }
      sendEvent(response, { type: 'response.completed' });
      response.end();
      return;
    case 'refusal':
      sendEvent(response, {
        type: 'response.refusal.done',
        refusal: behaviour.text,
      } as { type: string });
      sendEvent(response, { type: 'response.completed' });
      response.end();
      return;
    case 'disconnect':
      sendEvent(response, {
        type: 'response.output_text.delta',
        delta: 'Half a',
      } as { type: string });
      response.destroy();
  }
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const requests: RecordedRequest[] = [];
  let behaviours: Behaviour[] = [DEFAULT_REPLY];
  const structuredRequests: Record<string, unknown>[] = [];
  const plainRequests: Record<string, unknown>[] = [];
  let structuredBehaviours: StructuredBehaviour[] = [DEFAULT_STRUCTURED];
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = createServer((request, response) => {
    void (async () => {
      const listing = request.method === 'GET' && request.url === '/v1/models';
      if (
        !listing &&
        (request.method !== 'POST' || request.url !== '/v1/responses')
      ) {
        sendError(response, 404, `Unknown path ${String(request.url)}`);
        return;
      }
      if (request.headers.authorization !== `Bearer ${FAKE_API_KEY}`) {
        sendError(response, 401, 'Incorrect API key provided.');
        return;
      }
      if (listing) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: FAKE_MODELS.map((model) => ({
              ...model,
              object: 'model',
              owned_by: 'system',
            })),
          }),
        );
        return;
      }
      const body = JSON.parse(await readBody(request)) as Record<
        string,
        unknown
      >;
      const effort = (body.reasoning as { effort?: string } | undefined)
        ?.effort;
      if (body.stream !== true && body.text === undefined) {
        plainRequests.push(body);
      }
      const refusal =
        effort === undefined
          ? undefined
          : refuseEffort(String(body.model), effort);
      if (refusal !== undefined) {
        sendError(response, 400, refusal);
        return;
      }
      if (body.stream !== true && body.text === undefined) {
        answerStructured({ kind: 'text', text: 'Hi.' }, response);
        return;
      }
      if (body.stream === false) {
        structuredRequests.push(body);
        const next =
          structuredBehaviours.length > 1
            ? structuredBehaviours.shift()
            : structuredBehaviours[0];
        answerStructured(next ?? DEFAULT_STRUCTURED, response);
        return;
      }
      const recorded: RecordedRequest = {
        body: body as unknown as RecordedRequest['body'],
        abandoned: false,
      };
      requests.push(recorded);
      response.on('close', () => {
        recorded.abandoned = !response.writableEnded;
      });
      const behaviour =
        behaviours.length > 1 ? behaviours.shift() : behaviours[0];
      await answer(behaviour ?? DEFAULT_REPLY, response, released);
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    respondWith(...next) {
      behaviours = [...next];
    },
    structuredRequests,
    plainRequests,
    respondToStructuredWith(...next) {
      structuredBehaviours = [...next];
    },
    release() {
      release();
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
