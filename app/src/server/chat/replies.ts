// Getting a reply into a chat: saving the user's message, streaming the
// provider's reply, and saving what was written.

import { setTimeout as delay } from 'node:timers/promises';
import type {
  Character,
  ChatSummary,
  Message,
  Player,
  ReplyEvent,
  Scenario,
} from '../../shared/api.ts';
import type { SettingsStore } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { PlayerStore } from '../store/players.ts';
import type { ScenarioStore } from '../store/scenarios.ts';
import { buildPrompt } from './prompt.ts';
import { type ChatProvider, ProviderError, withEffort } from './provider.ts';

const STOP_ALL_TIMEOUT_MS = 2_000;

/** A request the chat cannot take right now. */
export class ChatBusyError extends Error {
  constructor() {
    super('A reply is already being written in this chat.');
  }
}

/** A request that makes no sense for the chat as it stands. */
export class ChatRequestError extends Error {}

/** Why no reply could be produced, in words for the user. */
function describeFailure(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  console.error('Unexpected failure while writing a reply:', error);
  return 'Something went wrong while writing the reply. Try again.';
}

export class ReplyService {
  readonly #chats: ChatStore;
  readonly #characters: CharacterStore;
  readonly #scenarios: ScenarioStore;
  readonly #players: PlayerStore;
  readonly #settings: SettingsStore;
  readonly #provider: ChatProvider;
  /** One entry per chat that has a reply in progress. */
  readonly #inProgress = new Map<string, AbortController>();
  readonly #savedListeners = new Set<
    (chatId: string, message: Message) => void
  >();

  constructor(
    chats: ChatStore,
    characters: CharacterStore,
    scenarios: ScenarioStore,
    players: PlayerStore,
    settings: SettingsStore,
    provider: ChatProvider,
  ) {
    this.#chats = chats;
    this.#characters = characters;
    this.#scenarios = scenarios;
    this.#players = players;
    this.#settings = settings;
    this.#provider = provider;
  }

  /**
   * Call `listener` with each reply once it is saved, new or regenerated.
   * What the listener does cannot affect the reply.
   */
  onReplySaved(listener: (chatId: string, message: Message) => void): void {
    this.#savedListeners.add(listener);
  }

  isReplying(chatId: string): boolean {
    return this.#inProgress.has(chatId);
  }

  /** Whether a reply is in progress in any chat that `matches`. */
  isReplyingWhere(matches: (chat: ChatSummary) => boolean): boolean {
    return this.#chats
      .list()
      .some((chat) => matches(chat) && this.isReplying(chat.id));
  }

  /** End the reply in progress in `chatId`, keeping what has been written. */
  stop(chatId: string): void {
    this.#inProgress.get(chatId)?.abort();
  }

  /** End every reply in progress, and wait for what they wrote to be saved. */
  async stopAll(): Promise<void> {
    for (const controller of this.#inProgress.values()) controller.abort();
    const deadline = Date.now() + STOP_ALL_TIMEOUT_MS;
    while (this.#inProgress.size > 0 && Date.now() < deadline) {
      await delay(10);
    }
  }

  /**
   * Save the user's message, then stream the reply to it. The caller must
   * read the events to the end, even if nobody is listening any more: the
   * reply is saved as the last step.
   */
  send(chatId: string, content: string): AsyncGenerator<ReplyEvent> {
    const controller = this.#begin(chatId);
    return this.#untilFinished(
      chatId,
      this.#sendAndReply(chatId, content, controller.signal),
    );
  }

  /**
   * Stream a new reply to the conversation as it stood before the last
   * reply, and put it in that reply's place. The old reply stays until the
   * new one has been written, so a failure loses nothing. If the last
   * message is the user's, this writes the reply it never got. The caller
   * must read the events to the end, as for `send`.
   */
  regenerate(chatId: string): AsyncGenerator<ReplyEvent> {
    if (this.isReplying(chatId)) throw new ChatBusyError();
    const messages = this.#chats.messages(chatId);
    const last = messages.at(-1);
    const replacing = last?.role === 'assistant' ? last : undefined;
    const conversation =
      replacing === undefined ? messages : messages.slice(0, -1);
    if (conversation.length === 0) {
      throw new ChatRequestError('There is no message to reply to yet.');
    }
    const controller = this.#begin(chatId);
    return this.#untilFinished(
      chatId,
      this.#reply(chatId, controller.signal, conversation, replacing),
    );
  }

  /** Remove the last message in the chat, whoever wrote it. */
  deleteLastMessage(chatId: string): void {
    if (this.isReplying(chatId)) throw new ChatBusyError();
    if (this.#chats.deleteLastMessage(chatId) === undefined) {
      throw new ChatRequestError('This chat has no messages to delete.');
    }
  }

  /** The character, scenario and player of `chatId`, as they are now. */
  #pairing(chatId: string): [Character, Scenario, Player | undefined] {
    const chat = this.#chats.find(chatId);
    const character =
      chat === undefined ? undefined : this.#characters.find(chat.character.id);
    const scenario =
      chat === undefined ? undefined : this.#scenarios.find(chat.scenario.id);
    if (character === undefined || scenario === undefined) {
      throw new Error(`Chat ${chatId} has lost its character or scenario.`);
    }
    const player =
      chat === undefined || chat.player === null
        ? undefined
        : this.#players.find(chat.player.id);
    return [character, scenario, player];
  }

  /** Mark `chatId` as replying, or throw `ChatBusyError` if it already is. */
  #begin(chatId: string): AbortController {
    if (this.#inProgress.has(chatId)) throw new ChatBusyError();
    const controller = new AbortController();
    this.#inProgress.set(chatId, controller);
    return controller;
  }

  /** Pass `events` on, and mark the chat as no longer replying at their end. */
  async *#untilFinished(
    chatId: string,
    events: AsyncGenerator<ReplyEvent>,
  ): AsyncGenerator<ReplyEvent> {
    try {
      yield* events;
    } finally {
      this.#inProgress.delete(chatId);
    }
  }

  async *#sendAndReply(
    chatId: string,
    content: string,
    signal: AbortSignal,
  ): AsyncGenerator<ReplyEvent> {
    const message = this.#chats.addMessage(chatId, 'user', content);
    yield { type: 'user-message', message };
    yield* this.#reply(chatId, signal, this.#chats.messages(chatId));
  }

  /**
   * Stream a reply to `conversation` and save it: in place of `replacing`
   * if given, else as a new message.
   */
  async *#reply(
    chatId: string,
    signal: AbortSignal,
    conversation: readonly Message[],
    replacing?: Message,
  ): AsyncGenerator<ReplyEvent> {
    let text = '';
    try {
      const prompt = buildPrompt(
        ...this.#pairing(chatId),
        conversation,
        this.#settings.contextTokenBudget(),
      );
      const pieces = this.#provider.streamReply({
        model: this.#settings.model(),
        ...withEffort(this.#settings.reasoningEffort()),
        ...prompt,
        signal,
      });
      for await (const piece of pieces) {
        text += piece;
        yield { type: 'delta', text: piece };
      }
    } catch (error) {
      // A stopped reply keeps what was written; any other failure discards it.
      if (!signal.aborted) {
        yield { type: 'error', message: describeFailure(error) };
        return;
      }
    }
    if (text.trim() === '') {
      yield signal.aborted
        ? { type: 'done', message: null }
        : { type: 'error', message: 'The model sent back an empty reply.' };
      return;
    }
    const saved =
      replacing === undefined
        ? this.#chats.addMessage(chatId, 'assistant', text)
        : this.#chats.replaceMessage(chatId, replacing, text);
    for (const listener of this.#savedListeners) {
      try {
        listener(chatId, saved);
      } catch (error) {
        console.error('A listener failed on a saved reply:', error);
      }
    }
    yield { type: 'done', message: saved };
  }
}
