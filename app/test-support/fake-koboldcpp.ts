// A stand-in for KoboldCpp, so tests need no local model and no other PC. It
// speaks what the app uses of KoboldCpp's API, in the format a real server
// was seen to use (issue #33):
//
// - `GET /v1/models` lists the one loaded model;
// - `GET /api/extra/true_max_context_length` gives its context length;
// - `POST /api/extra/tokencount` counts a text's tokens (`fakeTokenCount`);
// - `POST /v1/chat/completions` streams a reply as OpenAI's chat completions
//   do, with a thinking model's thoughts in `reasoning_content`, or answers a
//   request that does not stream (the scene call) in one piece.
//
// Every chat completion request is recorded, so tests can see what was sent.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** The model the fake has loaded unless a test loads another. */
export const FAKE_KOBOLDCPP_MODEL = 'koboldcpp/gemma-4-31B-it-Q4_K_S';
export const FAKE_CONTEXT_LENGTH = 8192;

/** The fake's tokeniser: a token per four characters, as English prose roughly is. */
export function fakeTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export type KoboldBehaviour =
  /**
   * Stream `chunks` as the reply, after `reasoning` as thoughts, pausing
   * `chunkDelayMs` before each. With `holdAfter`, that many chunks are sent
   * and the rest wait for `release()`.
   */
  | {
      kind: 'reply';
      chunks: string[];
      reasoning?: string[];
      chunkDelayMs?: number;
      holdAfter?: number;
      /** How the stream ends. `stop` unless given. */
      finishReason?: 'stop' | 'length';
    }
  /** The request is rejected before any streaming starts. */
  | { kind: 'http-error'; status: number; body: unknown }
  /** The stream starts, then the connection drops. */
  | { kind: 'disconnect' };

/** How a request that does not stream is answered. */
export type KoboldAnswer =
  /** The message's content is this text, which may not be JSON. */
  | { kind: 'text'; text: string; reasoning?: string }
  /** The request is rejected. */
  | { kind: 'http-error'; status: number; body: unknown };

export interface KoboldRequest {
  body: Record<string, unknown>;
  /** True once the client has given up on the response before its end. */
  abandoned: boolean;
}

export interface FakeKoboldCpp {
  /** The server's address, as typed into Settings. */
  address: string;
  /** Every chat completion request that streams, oldest first. */
  requests: KoboldRequest[];
  /** Every chat completion request that does not stream, oldest first. */
  structuredRequests: Record<string, unknown>[];
  /** How many times the loaded model was asked for. */
  modelChecks: number;
  /** How many texts were counted. */
  tokenCounts: number;
  /** Load another model, or none with `undefined`. */
  load(model: string | undefined, contextLength?: number): void;
  /**
   * Set how the next streamed requests are answered, one per request. The
   * last one repeats for every request after that.
   */
  respondWith(...behaviours: [KoboldBehaviour, ...KoboldBehaviour[]]): void;
  /** As `respondWith`, for requests that do not stream. */
  answerWith(...answers: [KoboldAnswer, ...KoboldAnswer[]]): void;
  /** Let replies held by `holdAfter` carry on to their end. */
  release(): void;
  close(): Promise<void>;
}

const DEFAULT_REPLY: KoboldBehaviour = {
  kind: 'reply',
  chunks: ['Hello', ' from', ' the', ' local', ' model.'],
};

/** A scene described as staying put, unremarkable. */
export const KOBOLD_SCENE = {
  action: 'Mara stands at the lamp-room window, looking out at the sea.',
  expression: 'calm and watchful',
  framing: 'medium shot',
  lighting: 'grey storm light',
  moved: false,
  location: { name: '', description: '' },
  worthIllustrating: false,
};

const DEFAULT_ANSWER: KoboldAnswer = {
  kind: 'text',
  text: JSON.stringify(KOBOLD_SCENE),
};

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** One streamed chunk, as KoboldCpp sends it. */
function chunk(
  model: string,
  delta: Record<string, string>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-A553873',
    object: 'chat.completion.chunk',
    created: 1_795_697_704,
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        delta: { role: 'assistant', ...delta },
      },
    ],
  })}\n\n`;
}

async function stream(
  behaviour: KoboldBehaviour,
  model: string,
  response: ServerResponse,
  released: Promise<void>,
): Promise<void> {
  if (behaviour.kind === 'http-error') {
    sendJson(response, behaviour.status, behaviour.body);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (behaviour.kind === 'disconnect') {
    response.write(chunk(model, { content: 'Half a' }));
    response.destroy();
    return;
  }
  for (const thought of behaviour.reasoning ?? []) {
    response.write(chunk(model, { reasoning_content: thought }));
  }
  for (const [index, text] of behaviour.chunks.entries()) {
    if (index === behaviour.holdAfter) await released;
    if (behaviour.chunkDelayMs !== undefined) {
      await delay(behaviour.chunkDelayMs);
    }
    if (response.destroyed) return;
    response.write(chunk(model, { content: text }));
  }
  response.write(
    chunk(model, { content: '' }, behaviour.finishReason ?? 'stop'),
  );
  response.write('data: [DONE]\n\n');
  response.end();
}

function answer(
  next: KoboldAnswer,
  model: string,
  response: ServerResponse,
): void {
  if (next.kind === 'http-error') {
    sendJson(response, next.status, next.body);
    return;
  }
  sendJson(response, 200, {
    id: 'chatcmpl-B1',
    object: 'chat.completion',
    created: 1_795_697_704,
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: next.text,
          ...(next.reasoning !== undefined && {
            reasoning_content: next.reasoning,
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

export async function startFakeKoboldCpp(): Promise<FakeKoboldCpp> {
  let model: string | undefined = FAKE_KOBOLDCPP_MODEL;
  let contextLength = FAKE_CONTEXT_LENGTH;
  let behaviours: KoboldBehaviour[] = [DEFAULT_REPLY];
  let answers: KoboldAnswer[] = [DEFAULT_ANSWER];
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake: Omit<FakeKoboldCpp, 'address'> = {
    requests: [],
    structuredRequests: [],
    modelChecks: 0,
    tokenCounts: 0,
    load(next, length = FAKE_CONTEXT_LENGTH) {
      model = next;
      contextLength = length;
    },
    respondWith(...next) {
      behaviours = [...next];
    },
    answerWith(...next) {
      answers = [...next];
    },
    release() {
      release();
    },
    close: () => Promise.resolve(),
  };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        fake.modelChecks += 1;
        sendJson(response, 200, {
          object: 'list',
          data:
            model === undefined
              ? []
              : [
                  {
                    id: model,
                    object: 'model',
                    created: 1_795_698_657,
                    owned_by: 'koboldcpp',
                    status: { value: 'loaded' },
                    permission: [],
                    root: 'koboldcpp',
                  },
                ],
        });
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/api/extra/true_max_context_length'
      ) {
        sendJson(response, 200, { value: contextLength });
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/api/extra/tokencount'
      ) {
        const { prompt } = JSON.parse(await readBody(request)) as {
          prompt: string;
        };
        fake.tokenCounts += 1;
        sendJson(response, 200, { value: fakeTokenCount(prompt), ids: [] });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        sendJson(response, 404, {
          detail: { msg: `Unknown path ${String(request.url)}` },
        });
        return;
      }
      const body = JSON.parse(await readBody(request)) as Record<
        string,
        unknown
      >;
      if (body.stream !== true) {
        fake.structuredRequests.push(body);
        const next = answers.length > 1 ? answers.shift() : answers[0];
        answer(next ?? DEFAULT_ANSWER, String(body.model), response);
        return;
      }
      const recorded: KoboldRequest = { body, abandoned: false };
      fake.requests.push(recorded);
      response.on('close', () => {
        recorded.abandoned = !response.writableEnded;
      });
      const next = behaviours.length > 1 ? behaviours.shift() : behaviours[0];
      await stream(
        next ?? DEFAULT_REPLY,
        String(body.model),
        response,
        released,
      );
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    address: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  });
}
