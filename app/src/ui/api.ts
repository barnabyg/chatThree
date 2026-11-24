// The UI's view of the server's HTTP API.

import type {
  Character,
  CharacterInput,
  Chat,
  ChatSummary,
  ReplyEvent,
  Scenario,
  ScenarioInput,
  Settings,
  SettingsUpdate,
} from '../shared/api.ts';

const NOT_RUNNING =
  'chatThree is not running. Start it again, then reload this page.';

/** A failure as text to show the user. */
export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

const changeListeners = new Set<() => void>();

/**
 * Call `listener` whenever this page changes anything on the server, so
 * that views of shared data (the chat list) can reload. Returns the function
 * that stops the calls.
 */
export function onDataChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function dataChanged(): void {
  for (const listener of changeListeners) listener();
}

async function send(
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      ...(body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch {
    throw new Error(NOT_RUNNING);
  }
}

async function failure(response: Response): Promise<string> {
  try {
    const { error } = (await response.json()) as { error?: unknown };
    if (typeof error === 'string') return error;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `chatThree answered with an error (${String(response.status)}).`;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await send(method, url, body);
  if (!response.ok) throw new Error(await failure(response));
  if (method !== 'GET') dataChanged();
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

/**
 * Ask for a reply and yield its events as they arrive. Always ends with a
 * `done` or an `error` event, whatever goes wrong.
 */
async function* reply(url: string, body?: unknown): AsyncGenerator<ReplyEvent> {
  try {
    yield* replyEvents(url, body);
  } finally {
    dataChanged();
  }
}

async function* replyEvents(
  url: string,
  body?: unknown,
): AsyncGenerator<ReplyEvent> {
  let finished = false;
  try {
    const response = await send('POST', url, body);
    if (!response.ok || response.body === null) {
      yield { type: 'error', message: await failure(response) };
      return;
    }
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = JSON.parse(line) as ReplyEvent;
        finished = event.type === 'done' || event.type === 'error';
        yield event;
      }
    }
  } catch (error) {
    if (!finished) {
      finished = true;
      yield {
        type: 'error',
        message:
          error instanceof Error && error.message === NOT_RUNNING
            ? NOT_RUNNING
            : 'The connection to chatThree was lost before the reply finished.',
      };
    }
  }
  if (!finished) {
    yield {
      type: 'error',
      message:
        'The connection to chatThree was lost before the reply finished.',
    };
  }
}

export const api = {
  listChats: () => request<ChatSummary[]>('GET', '/api/chats'),
  createChat: (characterId: string, scenarioId: string) =>
    request<Chat>('POST', '/api/chats', { characterId, scenarioId }),
  deleteChat: (id: string) => request<undefined>('DELETE', `/api/chats/${id}`),
  getChat: (id: string) => request<Chat>('GET', `/api/chats/${id}`),
  sendMessage: (chatId: string, content: string) =>
    reply(`/api/chats/${chatId}/messages`, { content }),
  regenerate: (chatId: string) => reply(`/api/chats/${chatId}/regenerate`),
  deleteLastMessage: (chatId: string) =>
    request<Chat>('DELETE', `/api/chats/${chatId}/messages/last`),
  stopReply: (chatId: string) =>
    request<undefined>('POST', `/api/chats/${chatId}/stop`),
  listCharacters: () => request<Character[]>('GET', '/api/characters'),
  getCharacter: (id: string) =>
    request<Character>('GET', `/api/characters/${id}`),
  createCharacter: (character: CharacterInput) =>
    request<Character>('POST', '/api/characters', character),
  updateCharacter: (id: string, character: CharacterInput) =>
    request<Character>('PUT', `/api/characters/${id}`, character),
  deleteCharacter: (id: string) =>
    request<undefined>('DELETE', `/api/characters/${id}`),
  listScenarios: () => request<Scenario[]>('GET', '/api/scenarios'),
  getScenario: (id: string) => request<Scenario>('GET', `/api/scenarios/${id}`),
  createScenario: (scenario: ScenarioInput) =>
    request<Scenario>('POST', '/api/scenarios', scenario),
  updateScenario: (id: string, scenario: ScenarioInput) =>
    request<Scenario>('PUT', `/api/scenarios/${id}`, scenario),
  deleteScenario: (id: string) =>
    request<undefined>('DELETE', `/api/scenarios/${id}`),
  getSettings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (update: SettingsUpdate) =>
    request<Settings>('PUT', '/api/settings', update),
};
