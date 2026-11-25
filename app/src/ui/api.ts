// The UI's view of the server's HTTP API.

import type {
  Character,
  CharacterInput,
  Chat,
  ChatSummary,
  ModelList,
  ModelReasoning,
  Player,
  PlayerInput,
  ReplyEvent,
  Scenario,
  ScenarioInput,
  Settings,
  SettingsUpdate,
  SpeechRequest,
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
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      ...(signal !== undefined && { signal }),
      ...(body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch {
    throw new Error(NOT_RUNNING);
  }
}

/** Send a file as the body of a request. */
async function sendFile<T>(
  method: string,
  url: string,
  file: Uint8Array<ArrayBuffer> | Blob,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  if (!response.ok) throw new Error(await failure(response));
  dataChanged();
  return (await response.json()) as T;
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

/** Have one sentence spoken. Resolves to the clip. Changes nothing on the server. */
async function speak(
  request: SpeechRequest,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await send('POST', '/api/speech', request, signal);
  if (!response.ok) throw new Error(await failure(response));
  return response.blob();
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
  /** Start a chat, played as `playerId` or, with `null`, as no one. */
  createChat: (
    characterId: string,
    scenarioId: string,
    playerId: string | null,
  ) =>
    request<Chat>('POST', '/api/chats', { characterId, scenarioId, playerId }),
  deleteChat: (id: string) => request<undefined>('DELETE', `/api/chats/${id}`),
  getChat: (id: string) => request<Chat>('GET', `/api/chats/${id}`),
  sendMessage: (chatId: string, content: string) =>
    reply(`/api/chats/${chatId}/messages`, { content }),
  regenerate: (chatId: string) => reply(`/api/chats/${chatId}/regenerate`),
  deleteLastMessage: (chatId: string) =>
    request<Chat>('DELETE', `/api/chats/${chatId}/messages/last`),
  /** Start a picture of one of the character's messages. Resolves to the chat, showing it under way. */
  illustrate: (chatId: string, messageId: number) =>
    request<Chat>(
      'POST',
      `/api/chats/${chatId}/messages/${String(messageId)}/illustrate`,
    ),
  /** Paint a new reference picture of one of a chat's places. Resolves to the chat. */
  repaintLocation: (chatId: string, locationId: number) =>
    request<Chat>(
      'POST',
      `/api/chats/${chatId}/locations/${String(locationId)}/image/generate`,
    ),
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
  /** Give a character a voice, from a WAV clip. */
  setVoice: (id: string, clip: Uint8Array<ArrayBuffer>) =>
    sendFile<Character>('PUT', `/api/characters/${id}/voice`, clip),
  removeVoice: (id: string) =>
    request<Character>('DELETE', `/api/characters/${id}/voice`),
  /** Have the engine make a character's reference picture from `appearance`. */
  generatePicture: (id: string, appearance: string) =>
    request<Character>('POST', `/api/characters/${id}/image/generate`, {
      appearance,
    }),
  /** Use an image file of the user's own as a character's reference picture. */
  setPicture: (id: string, picture: Blob) =>
    sendFile<Character>('PUT', `/api/characters/${id}/image`, picture),
  /**
   * Have a character's voice made ready ahead of its first sentence. Nothing
   * waits on it and nothing is shown if it fails: speaking still works.
   */
  warmVoice: (id: string): void => {
    void send('POST', `/api/characters/${id}/voice/warm`).catch(
      () => undefined,
    );
  },
  listScenarios: () => request<Scenario[]>('GET', '/api/scenarios'),
  getScenario: (id: string) => request<Scenario>('GET', `/api/scenarios/${id}`),
  createScenario: (scenario: ScenarioInput) =>
    request<Scenario>('POST', '/api/scenarios', scenario),
  updateScenario: (id: string, scenario: ScenarioInput) =>
    request<Scenario>('PUT', `/api/scenarios/${id}`, scenario),
  deleteScenario: (id: string) =>
    request<undefined>('DELETE', `/api/scenarios/${id}`),
  listPlayers: () => request<Player[]>('GET', '/api/players'),
  getPlayer: (id: string) => request<Player>('GET', `/api/players/${id}`),
  createPlayer: (player: PlayerInput) =>
    request<Player>('POST', '/api/players', player),
  updatePlayer: (id: string, player: PlayerInput) =>
    request<Player>('PUT', `/api/players/${id}`, player),
  deletePlayer: (id: string) =>
    request<undefined>('DELETE', `/api/players/${id}`),
  getSettings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (update: SettingsUpdate) =>
    request<Settings>('PUT', '/api/settings', update),
  /** The OpenAI models that can write replies, newest first. */
  listModels: () => request<ModelList>('GET', '/api/models'),
  /** The thinking levels a model takes. The first ask for a model may take a few seconds. */
  modelReasoning: (model: string) =>
    request<ModelReasoning>(
      'GET',
      `/api/models/${encodeURIComponent(model)}/reasoning`,
    ),
  speak,
};
