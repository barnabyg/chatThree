// Replies from OpenAI's Responses API, streamed.
//
// The request is plain `fetch` rather than OpenAI's SDK: the app uses one
// endpoint, and this keeps the dependency list short.

import { isWellFormedApiKey } from '../apiKey.ts';
import {
  type ChatProvider,
  ProviderError,
  type ReplyRequest,
  type StructuredRequest,
} from './provider.ts';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

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

/** Parse a server-sent event stream into the JSON payload of each event. */
async function* streamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  let buffer = '';
  const text = body.pipeThrough(new TextDecoderStream());
  for await (const chunk of text) {
    buffer += chunk;
    // Events are separated by a blank line.
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (data !== '' && data !== '[DONE]') {
        yield JSON.parse(data) as StreamEvent;
      }
    }
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

  /** Ask for a response, and return it once OpenAI has accepted the request. */
  const post = async (
    body: object,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const key = apiKey();
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl}/responses`, {
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
    if (!response.ok) throw await rejection(response);
    return response;
  };

  return {
    async *streamReply({
      model,
      instructions,
      messages,
      signal,
    }: ReplyRequest) {
      const response = await post(
        { model, instructions, input: messages, stream: true },
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
      instructions,
      input,
      schemaName,
      schema,
      signal,
    }: StructuredRequest) {
      const response = await post(
        {
          model,
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
  };
}
