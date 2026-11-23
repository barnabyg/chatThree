// Getting a reply into a chat: saving the user's message, streaming the
// provider's reply, and saving what was written.

import { setTimeout as delay } from 'node:timers/promises';
import type { ReplyEvent } from '../../shared/api.ts';
import type { SettingsStore } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import { BUILT_IN_CHARACTER, BUILT_IN_SCENARIO } from './builtin.ts';
import { buildPrompt } from './prompt.ts';
import { type ChatProvider, ProviderError } from './provider.ts';

const STOP_ALL_TIMEOUT_MS = 2_000;

/** A request the chat cannot take right now. */
export class ChatBusyError extends Error {
  constructor() {
    super('A reply is already being written in this chat.');
  }
}

function userMessage(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  console.error('Unexpected failure while writing a reply:', error);
  return 'Something went wrong while writing the reply. Try again.';
}

export class ReplyService {
  readonly #chats: ChatStore;
  readonly #settings: SettingsStore;
  readonly #provider: ChatProvider;
  /** One entry per chat that has a reply in progress. */
  readonly #inProgress = new Map<string, AbortController>();

  constructor(
    chats: ChatStore,
    settings: SettingsStore,
    provider: ChatProvider,
  ) {
    this.#chats = chats;
    this.#settings = settings;
    this.#provider = provider;
  }

  isReplying(chatId: string): boolean {
    return this.#inProgress.has(chatId);
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
    return this.#run(chatId, controller, content);
  }

  /** Mark `chatId` as replying, or throw `ChatBusyError` if it already is. */
  #begin(chatId: string): AbortController {
    if (this.#inProgress.has(chatId)) throw new ChatBusyError();
    const controller = new AbortController();
    this.#inProgress.set(chatId, controller);
    return controller;
  }

  async *#run(
    chatId: string,
    controller: AbortController,
    content: string,
  ): AsyncGenerator<ReplyEvent> {
    try {
      const message = this.#chats.addMessage(chatId, 'user', content);
      yield { type: 'user-message', message };
      yield* this.#reply(chatId, controller.signal);
    } finally {
      this.#inProgress.delete(chatId);
    }
  }

  async *#reply(
    chatId: string,
    signal: AbortSignal,
  ): AsyncGenerator<ReplyEvent> {
    let text = '';
    try {
      const prompt = buildPrompt(
        BUILT_IN_CHARACTER,
        BUILT_IN_SCENARIO,
        this.#chats.messages(chatId),
      );
      const pieces = this.#provider.streamReply({
        model: this.#settings.model(),
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
        yield { type: 'error', message: userMessage(error) };
        return;
      }
    }
    if (text.trim() === '') {
      yield signal.aborted
        ? { type: 'done', message: null }
        : { type: 'error', message: 'The model sent back an empty reply.' };
      return;
    }
    yield {
      type: 'done',
      message: this.#chats.addMessage(chatId, 'assistant', text),
    };
  }
}
