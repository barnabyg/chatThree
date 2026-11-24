// A stand-in for OpenAI's Responses API, so tests need no key and no network.
// It speaks the same streaming wire format as `POST /v1/responses`, checks the
// API key, and records every request so tests can see what was sent.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** The only key the fake accepts. Anything else gets OpenAI's 401. */
export const FAKE_API_KEY = 'sk-test-0000';

export type Behaviour =
  /** Stream `chunks` as the reply, pausing `chunkDelayMs` before each. */
  | { kind: 'reply'; chunks: string[]; chunkDelayMs?: number }
  /** The model declines to answer. */
  | { kind: 'refusal'; text: string }
  /** The request is rejected before any streaming starts. */
  | { kind: 'http-error'; status: number; message: string }
  /** The stream starts, then the connection drops. */
  | { kind: 'disconnect' };

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
  close(): Promise<void>;
}

const DEFAULT_REPLY: Behaviour = {
  kind: 'reply',
  chunks: ['Hello', ' from', ' the', ' fake', ' model.'],
};

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
): Promise<void> {
  if (behaviour.kind === 'http-error') {
    sendError(response, behaviour.status, behaviour.message);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sendEvent(response, { type: 'response.created' });
  switch (behaviour.kind) {
    case 'reply':
      for (const chunk of behaviour.chunks) {
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

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        sendError(response, 404, `Unknown path ${String(request.url)}`);
        return;
      }
      if (request.headers.authorization !== `Bearer ${FAKE_API_KEY}`) {
        sendError(response, 401, 'Incorrect API key provided.');
        return;
      }
      const recorded: RecordedRequest = {
        body: JSON.parse(await readBody(request)) as RecordedRequest['body'],
        abandoned: false,
      };
      requests.push(recorded);
      response.on('close', () => {
        recorded.abandoned = !response.writableEnded;
      });
      const behaviour =
        behaviours.length > 1 ? behaviours.shift() : behaviours[0];
      await answer(behaviour ?? DEFAULT_REPLY, response);
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
