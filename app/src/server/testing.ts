// Helpers for tests of the HTTP API. Each call builds an app of its own, with
// an in-memory database and a settings file in a temporary directory of its
// own, so tests share nothing.

import path from 'node:path';
import type { Hono } from 'hono';
import { temporaryDirectory } from '../../test-support/temporary.ts';
import type {
  Chat,
  EngineStatus,
  ReplyEvent,
  ScenarioInput,
} from '../shared/api.ts';
import { createApp } from './app.ts';
import type { ChatProvider, ReplyRequest } from './chat/provider.ts';
import type { EngineJobs } from './engine/jobs.ts';
import { ReplyService } from './chat/replies.ts';
import type { EngineControl } from './engine/supervisor.ts';
import { SettingsStore } from './settings.ts';
import { CharacterStore } from './store/characters.ts';
import { ChatStore } from './store/chats.ts';
import { openDatabase } from './store/database.ts';
import { ScenarioStore } from './store/scenarios.ts';

/** Headers of a request from the app's own UI. */
export const LOCAL = { host: '127.0.0.1:3210' };

export type StubEngine = EngineControl & { set(status: EngineStatus): void };

export function stubEngine(initial: EngineStatus): StubEngine {
  let current = initial;
  const listeners = new Set<(status: EngineStatus) => void>();
  const set = (status: EngineStatus): void => {
    current = status;
    for (const listener of listeners) listener(status);
  };
  return {
    status: () => current,
    url: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart() {
      set({ state: 'loading' });
      return Promise.resolve();
    },
    set,
  };
}

/** One job the fake engine was asked to do. */
export interface JobRequest {
  job: 'speak';
  text: string;
}

export type FakeJobs = EngineJobs & {
  /** Every job asked for, oldest first. */
  requests: JobRequest[];
  /** What every spoken sentence comes back as. */
  clip: Uint8Array<ArrayBuffer>;
  /** Make every job from now on fail with `error`. */
  failWith(error: Error): void;
};

/** An engine that does every job at once, and records what it was asked. */
export function fakeJobs(): FakeJobs {
  const requests: JobRequest[] = [];
  const clip = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  let failure: Error | undefined;
  const record = (request: JobRequest): void => {
    if (failure !== undefined) throw failure;
    requests.push(request);
  };
  return {
    requests,
    clip,
    failWith(error) {
      failure = error;
    },
    speak(text) {
      return Promise.resolve().then(() => {
        record({ job: 'speak', text });
        return clip;
      });
    },
  };
}

/** How the scripted provider answers one request. */
export interface ScriptedReply {
  pieces: string[];
  /** After the pieces, fail with this error. */
  thenFail?: Error;
  /** After the pieces, wait until the reply is stopped. */
  thenWait?: boolean;
}

export type ScriptedProvider = ChatProvider & {
  /** Every request received, oldest first. */
  requests: ReplyRequest[];
  /** Queue the answers to the next requests. Unscripted requests get "Hello." */
  script(...replies: ScriptedReply[]): void;
};

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException('The reply was stopped.', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function scriptedProvider(): ScriptedProvider {
  const requests: ReplyRequest[] = [];
  const queue: ScriptedReply[] = [];
  return {
    requests,
    script(...replies) {
      queue.push(...replies);
    },
    async *streamReply(request) {
      requests.push(request);
      const reply = queue.shift() ?? { pieces: ['Hello.'] };
      for (const piece of reply.pieces) {
        // Let the reader take each piece before the next, as a network would.
        await Promise.resolve();
        yield piece;
      }
      if (reply.thenFail !== undefined) throw reply.thenFail;
      if (reply.thenWait === true) await untilAborted(request.signal);
    },
  };
}

export interface TestApp {
  app: Hono;
  provider: ScriptedProvider;
  jobs: FakeJobs;
  chats: ChatStore;
  characters: CharacterStore;
  scenarios: ScenarioStore;
  settings: SettingsStore;
  /** Send a JSON request as the app's own UI would. */
  call(method: string, url: string, body?: unknown): Promise<Response>;
  /**
   * Start a chat through the API. Unless told otherwise it is with the
   * built-in character, in a scenario that has no opening message, so the
   * conversation starts empty.
   */
  startChat(pairing?: {
    characterId?: string;
    scenarioId?: string;
  }): Promise<Chat>;
}

/** A scenario with nothing in it but a title. */
export const BLANK_SCENARIO: ScenarioInput = {
  title: 'An empty room',
  premise: '',
  userPersona: { name: '', description: '' },
  openingMessage: '',
  startingLocation: { name: '', description: '' },
};

export function testApp(
  options: {
    uiDir?: string;
    engine?: EngineControl;
    environmentApiKey?: string;
  } = {},
): TestApp {
  const directory = temporaryDirectory('api');
  const database = openDatabase(':memory:');
  const chats = new ChatStore(database);
  const characters = new CharacterStore(database);
  const scenarios = new ScenarioStore(database);
  const settings = new SettingsStore(
    path.join(directory, 'settings.json'),
    options.environmentApiKey,
  );
  const provider = scriptedProvider();
  const jobs = fakeJobs();
  const app = createApp({
    uiDir: options.uiDir ?? path.join(directory, 'no-ui'),
    engine: options.engine ?? stubEngine({ state: 'ready' }),
    jobs,
    chats,
    characters,
    scenarios,
    settings,
    replies: new ReplyService(chats, characters, scenarios, settings, provider),
  });
  const call: TestApp['call'] = async (method, url, body) =>
    app.request(url, {
      method,
      headers: {
        ...LOCAL,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return {
    app,
    provider,
    jobs,
    chats,
    characters,
    scenarios,
    settings,
    call,
    async startChat(pairing = {}) {
      const response = await call('POST', '/api/chats', {
        characterId: pairing.characterId ?? characters.list()[0]?.id,
        scenarioId: pairing.scenarioId ?? scenarios.create(BLANK_SCENARIO).id,
      });
      if (response.status !== 201) {
        throw new Error(`Starting a chat failed: ${await response.text()}`);
      }
      return (await response.json()) as Chat;
    },
  };
}

/** Read a streamed reply to its end. */
export async function replyEvents(response: Response): Promise<ReplyEvent[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ReplyEvent);
}

/** Read a streamed reply one event at a time. */
export async function* readReply(
  response: Response,
): AsyncGenerator<ReplyEvent> {
  if (response.body === null) throw new Error('expected a streamed body');
  let buffer = '';
  for await (const chunk of response.body.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) yield JSON.parse(line) as ReplyEvent;
  }
}
