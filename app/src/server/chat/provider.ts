// The seam between the app and whichever service writes the text: OpenAI
// (openai.ts) or KoboldCpp (koboldcpp.ts), chosen as the text backend
// (backend.ts). Another one implements `ChatProvider` and nothing else in the
// app changes.

import type { Message, ReasoningEffort } from '../../shared/api.ts';

export interface PromptMessage {
  role: Message['role'];
  content: string;
}

export interface ReplyRequest {
  /** The OpenAI model. KoboldCpp uses the model it has loaded instead. */
  model: string;
  /** Left out, the model thinks as much as it does by default. */
  reasoningEffort?: ReasoningEffort;
  /** The fixed prefix: character, then scenario. Identical on every turn of a chat. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the user's message. */
  messages: PromptMessage[];
  /**
   * The character's name and the player's, if any, for a provider that fills
   * them into stop sequences as reply prompts are filled.
   */
  names?: { character: string; player: string | undefined };
  /** Aborting ends the reply early. */
  signal: AbortSignal;
}

/** A request for an answer in JSON, written to a schema. */
export interface StructuredRequest {
  model: string;
  reasoningEffort?: ReasoningEffort;
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
   * An answer in JSON that follows `request.schema`, parsed. The caller
   * checks it: a provider that holds the model to the schema need not.
   * Throws `ProviderError` when no answer can be produced.
   */
  structured(request: StructuredRequest): Promise<unknown>;
  /**
   * The models that can write replies, newest first.
   * Throws `ProviderError` when they cannot be listed.
   */
  models(): Promise<string[]>;
  /**
   * The thinking levels `model` supports, least first: empty when it has none
   * to choose. Finding out may cost a few small requests, so callers cache it.
   * Throws `ProviderError` when it cannot be found out.
   */
  reasoningEfforts(model: string): Promise<ReasoningEffort[]>;
}

/** `reasoningEffort` for a request, left out when the model's default is wanted. */
export function withEffort(effort: ReasoningEffort | undefined): {
  reasoningEffort?: ReasoningEffort;
} {
  return effort === undefined ? {} : { reasoningEffort: effort };
}

/** A failure to get a reply, with a message written to be shown to the user. */
export class ProviderError extends Error {
  override name = 'ProviderError';
}
