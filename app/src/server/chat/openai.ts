// Replies from OpenAI's Responses API, streamed.
//
// The requests are plain `fetch` rather than OpenAI's SDK: the app uses two
// endpoints, and this keeps the dependency list short.

import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/api.ts';
import { isWellFormedApiKey } from '../apiKey.ts';
import {
  type ChatProvider,
  ProviderError,
  type ReplyRequest,
  type StructuredRequest,
} from './provider.ts';
import { eventData } from './sse.ts';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Whether a model from `GET /models` can write a chat reply. The list says
 * nothing about what a model does, so this goes by name: OpenAI's text
 * families, without the models for pictures, sound, search, code or other
 * special work, and without dated snapshots of a model also listed by name.
 */
export function isChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chat-latest$)/.test(id)) return false;
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  return !/image|audio|realtime|tts|transcribe|whisper|embedding|moderation|search|live|codex|healthcare|instruct/.test(
    id,
  );
}

/**
 * The thinking levels to try, in an order that finds one the model refuses
 * quickly: a refusal names every level the model supports. Most models take
 * only one of `minimal` and `max`.
 */
const PROBE_ORDER: readonly ReasoningEffort[] = [
  'minimal',
  'max',
  'none',
  'xhigh',
  'low',
  'high',
  'medium',
];

/** The thinking levels named in OpenAI's refusal of one, or `undefined` if it names none. */
export function supportedEfforts(
  message: string,
): ReasoningEffort[] | undefined {
  const list = /Supported values are:(.*)$/s.exec(message)?.[1];
  if (list === undefined) return undefined;
  const named = new Set(
    [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]),
  );
  return REASONING_EFFORTS.filter((effort) => named.has(effort));
}

export interface OpenAIOptions {
  baseUrl: string;
  /** Read on every request, so a key saved in settings takes effect at once. */
  apiKey: () => string | undefined;
}

/** The streaming events the app acts on. All others are ignored. */
interface StreamEvent {
  type?: string;
  delta?: string;
  refusal?: string;
  message?: string;
  response?: {
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
}

/** The JSON payload of each event in a server-sent event stream. */
async function* streamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  for await (const data of eventData(body)) {
    if (data !== '[DONE]') yield JSON.parse(data) as StreamEvent;
  }
}

async function rejection(response: Response): Promise<ProviderError> {
  if (response.status === 401) {
    // OpenAI's own message quotes part of the key, so it is not passed on.
    return new ProviderError(
      'OpenAI rejected the API key. Check the key in Settings.',
    );
  }
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? detail;
  } catch {
    // Not JSON: the status text will do.
  }
  return new ProviderError(
    `OpenAI returned an error (${String(response.status)}): ${detail}`,
  );
}

/** The error to report when OpenAI could not be reached, or was cut off. */
function networkFailure(error: unknown): ProviderError {
  const cause = error instanceof Error ? error.cause : undefined;
  const detail =
    cause instanceof Error
      ? cause.message
      : error instanceof Error
        ? error.message
        : String(error);
  return new ProviderError(
    `Could not reach OpenAI (${detail}). Check your network connection and try again.`,
  );
}

/** A non-streamed response: only the parts the app reads. */
interface CompletedResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: {
    type?: string;
    content?: { type?: string; text?: string; refusal?: string }[];
  }[];
}

/** The text of a non-streamed response, or why there is none. */
function answerText(response: CompletedResponse): string {
  const content = (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  const refusal = content.find((part) => part.type === 'refusal');
  if (refusal !== undefined) {
    throw new ProviderError(
      `The model declined to answer: ${refusal.refusal ?? 'no reason given.'}`,
    );
  }
  if (response.status === 'failed') {
    throw new ProviderError(
      `OpenAI could not complete the answer: ${response.error?.message ?? 'no reason given.'}`,
    );
  }
  if (response.status === 'incomplete') {
    throw new ProviderError(
      `OpenAI did not finish the answer (${response.incomplete_details?.reason ?? 'no reason given'}).`,
    );
  }
  return content
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
}

export function openAIProvider(options: OpenAIOptions): ChatProvider {
  /** The key to send, or the reason there is no usable one. */
  const apiKey = (): string => {
    const key = options.apiKey();
    if (key === undefined || key === '') {
      throw new ProviderError(
        'No OpenAI API key is set. Add one in Settings, or set OPENAI_API_KEY before starting chatThree.',
      );
    }
    if (!isWellFormedApiKey(key)) {
      throw new ProviderError(
        'The OpenAI API key is not a valid key: it contains a space, a line break or another character a key cannot have. Enter it again in Settings.',
      );
    }
    return key;
  };

  /** Ask for a response, whether or not OpenAI accepts the request. */
  const send = async (
    body: object,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const key = apiKey();
    try {
      return await fetch(`${options.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: accept,
        },
        body: JSON.stringify({
          ...body,
          // The app keeps the conversation itself; OpenAI need not store it.
          store: false,
        }),
        ...(signal !== undefined && { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw networkFailure(error);
    }
  };

  /** Ask for a response, and return it once OpenAI has accepted the request. */
  const post = async (
    body: object,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const response = await send(body, accept, signal);
    if (!response.ok) throw await rejection(response);
    return response;
  };

  /** The request body's thinking level, if one was chosen. */
  const reasoning = (effort: ReasoningEffort | undefined): object =>
    effort === undefined ? {} : { reasoning: { effort } };

  return {
    async *streamReply({
      model,
      reasoningEffort,
      instructions,
      messages,
      signal,
    }: ReplyRequest) {
      const response = await post(
        {
          model,
          ...reasoning(reasoningEffort),
          instructions,
          input: messages,
          stream: true,
        },
        'text/event-stream',
        signal,
      );
      if (response.body === null) {
        throw new ProviderError('OpenAI sent an empty response.');
      }
      try {
        for await (const event of streamEvents(response.body)) {
          switch (event.type) {
            case 'response.output_text.delta':
              if (event.delta !== undefined) yield event.delta;
              break;
            case 'response.refusal.done':
              throw new ProviderError(
                `The model declined to reply: ${event.refusal ?? 'no reason given.'}`,
              );
            case 'response.failed':
              throw new ProviderError(
                `OpenAI could not complete the reply: ${event.response?.error?.message ?? 'no reason given.'}`,
              );
            case 'error':
              throw new ProviderError(
                `OpenAI reported an error: ${event.message ?? 'no detail given.'}`,
              );
            case 'response.incomplete':
              if (
                event.response?.incomplete_details?.reason === 'content_filter'
              ) {
                throw new ProviderError(
                  "OpenAI's content filter stopped the reply.",
                );
              }
              // Cut short by a length limit: what arrived is still the reply.
              return;
            case 'response.completed':
              return;
          }
        }
      } catch (error) {
        if (error instanceof ProviderError || signal.aborted) throw error;
        throw networkFailure(error);
      }
      throw new ProviderError(
        'The connection to OpenAI ended before the reply was complete. Try again.',
      );
    },

    async structured({
      model,
      reasoningEffort,
      instructions,
      input,
      schemaName,
      schema,
      signal,
    }: StructuredRequest) {
      const response = await post(
        {
          model,
          ...reasoning(reasoningEffort),
          instructions,
          input,
          stream: false,
          text: {
            format: {
              type: 'json_schema',
              name: schemaName,
              strict: true,
              schema,
            },
          },
        },
        'application/json',
        signal,
      );
      let body: CompletedResponse;
      try {
        body = (await response.json()) as CompletedResponse;
      } catch (error) {
        if (signal?.aborted === true) throw error;
        throw new ProviderError(
          'OpenAI sent back a response that is not JSON.',
        );
      }
      const text = answerText(body);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderError('OpenAI sent back an answer that is not JSON.');
      }
    },

    async models() {
      const key = apiKey();
      let response: Response;
      try {
        response = await fetch(`${options.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
      } catch (error) {
        throw networkFailure(error);
      }
      if (!response.ok) throw await rejection(response);
      let body: { data?: { id?: unknown; created?: unknown }[] };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new ProviderError(
          'OpenAI sent back a model list that is not JSON.',
        );
      }
      return (body.data ?? [])
        .flatMap(({ id, created }) =>
          typeof id === 'string' && isChatModel(id)
            ? [{ id, created: typeof created === 'number' ? created : 0 }]
            : [],
        )
        .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
        .map(({ id }) => id);
    },

    async reasoningEfforts(model) {
      // OpenAI cannot be asked which levels a model takes, but its refusal of
      // a level the model does not take lists the ones it does. A level the
      // model takes is answered, as briefly as OpenAI allows, and the next
      // one is tried.
      for (const effort of PROBE_ORDER) {
        const response = await send(
          { model, input: '.', max_output_tokens: 16, reasoning: { effort } },
          'application/json',
          undefined,
        );
        if (response.ok) {
          await response.body?.cancel();
          continue;
        }
        if (response.status !== 400) throw await rejection(response);
        let message = '';
        try {
          const body = (await response.json()) as {
            error?: { message?: string };
          };
          message = body.error?.message ?? '';
        } catch {
          // Not JSON: reported below.
        }
        // A model that does not think at all refuses the parameter itself.
        if (/Unsupported parameter/i.test(message)) return [];
        const supported = supportedEfforts(message);
        if (supported !== undefined) return supported;
        throw new ProviderError(
          `OpenAI returned an error (400): ${message === '' ? 'no detail given.' : message}`,
        );
      }
      // It took every level.
      return [...REASONING_EFFORTS];
    },
  };
}
