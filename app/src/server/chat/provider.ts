// The seam between the app and whichever service writes the replies.
// OpenAI is the only provider today (openai.ts); another one implements
// `ChatProvider` and nothing else in the app changes.

import type { Message } from '../../shared/api.ts';

export interface PromptMessage {
  role: Message['role'];
  content: string;
}

export interface ReplyRequest {
  model: string;
  /** The fixed prefix: character, then scenario. Identical on every turn of a chat. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the user's message. */
  messages: PromptMessage[];
  /** Aborting ends the reply early. */
  signal: AbortSignal;
}

/** A request for an answer in JSON, written to a schema. */
export interface StructuredRequest {
  model: string;
  instructions: string;
  /** What the answer is about, as one piece of text. */
  input: string;
  /** A name for the schema, of letters, digits, `_` and `-`. */
  schemaName: string;
  /** A JSON Schema the provider holds the answer to. */
  schema: object;
  /** Aborting gives up on the answer. */
  signal?: AbortSignal;
}

export interface ChatProvider {
  /**
   * Stream the reply as pieces of text, in order.
   * Throws `ProviderError` when no reply can be produced.
   */
  streamReply(request: ReplyRequest): AsyncIterable<string>;
  /**
   * An answer in JSON that follows `request.schema`, parsed but not checked.
   * Throws `ProviderError` when no answer can be produced.
   */
  structured(request: StructuredRequest): Promise<unknown>;
}

/** A failure to get a reply, with a message written to be shown to the user. */
export class ProviderError extends Error {
  override name = 'ProviderError';
}
