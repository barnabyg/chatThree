// Replies from a local model served by KoboldCpp, usually on another PC on
// the LAN, through its OpenAI-compatible chat completions endpoint. KoboldCpp
// applies the model's chat template itself. It holds one model at a time,
// which the app finds out rather than picks (see docs/adr/0001).
//
// What KoboldCpp sends was checked against a real server (issue #33): the
// stream is OpenAI's chat completions format, a thinking model's thoughts
// arrive in `reasoning_content` beside `content`, and a second request waits
// for the first rather than being refused. So the first token can take a
// long time, and a stream is always read to its end or aborted. Node's
// `fetch` waits five minutes for the response to start, which is enough for a
// long prompt on a slow PC; no shorter timeout is set.

import {
  type ChatProvider,
  ProviderError,
  type PromptMessage,
  type ReplyRequest,
  type StructuredRequest,
} from './provider.ts';
import { eventData } from './sse.ts';

/** The model KoboldCpp has loaded. */
export interface LoadedModel {
  /** As `/v1/models` gives it: `koboldcpp/` and the GGUF file's name. */
  id: string;
  /** The context length KoboldCpp was started with, in tokens. */
  contextLength: number;
}

export interface KoboldCppOptions {
  /** Read on every request, so a saved address takes effect at once. */
  address: () => string;
}

export interface KoboldCppProvider extends ChatProvider {
  /**
   * The model loaded at the saved address. Found out once and remembered for
   * the session, until the address changes or a request fails.
   * Throws `ProviderError` when it cannot be found out.
   */
  loadedModel(): Promise<LoadedModel>;
  /**
   * Ask `address` now which model it has loaded. Remembered when `address`
   * is the saved one. Throws `ProviderError` when it cannot be found out.
   */
  check(address: string): Promise<LoadedModel>;
  /** Forget the loaded model, so that the next request finds it out again. */
  forget(): void;
}

/**
 * `text` as a KoboldCpp address: `http://` added if no scheme is given, and
 * nothing after the port. `''` stays `''`. `undefined` if it cannot be one.
 */
export function koboldCppAddress(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  return `${url.protocol}//${url.host}`;
}

/** The detail of a network failure, from the error `fetch` threw. */
function networkDetail(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined && !cause.message.includes(code)
      ? `${cause.message}, ${code}`
      : cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The error to report when KoboldCpp could not be reached, or was cut off. */
export function networkFailure(address: string, error: unknown): ProviderError {
  const local = /\.local(:\d+)?$/i.test(address)
    ? ' A .local name can resolve to an IPv6 address that KoboldCpp does not listen on: use the PC’s IPv4 address instead, such as http://192.168.1.50:5001.'
    : '';
  return new ProviderError(
    `Could not reach KoboldCpp at ${address} (${networkDetail(error)}). Check that KoboldCpp is running there and that the address in Settings is right.${local}`,
  );
}

/** What KoboldCpp says went wrong, from a response that is not OK. */
async function rejection(
  address: string,
  response: Response,
): Promise<ProviderError> {
  if (response.status === 401) {
    return new ProviderError(
      `KoboldCpp at ${address} asks for a password, which chatThree does not send. Start KoboldCpp without --password.`,
    );
  }
  let detail = response.statusText;
  try {
    const text = await response.text();
    detail = text.trim() === '' ? detail : text.trim();
    const body = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      detail?: { msg?: unknown } | string;
    };
    const message =
      typeof body.error === 'string'
        ? body.error
        : typeof body.error?.message === 'string'
          ? body.error.message
          : typeof body.detail === 'string'
            ? body.detail
            : typeof body.detail?.msg === 'string'
              ? body.detail.msg
              : undefined;
    if (message !== undefined) detail = message;
  } catch {
    // Not JSON: the text, or the status text, will do.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  return new ProviderError(
    `KoboldCpp at ${address} returned an error (${String(response.status)}): ${detail}`,
  );
}

/** One chunk of a streamed chat completion: only the parts the app reads. */
interface StreamChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  error?: { message?: string } | string;
}

/** A non-streamed chat completion: only the parts the app reads. */
interface Completion {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
}

/** The messages of a chat completion request: the instructions first. */
export function chatMessages(
  instructions: string,
  messages: readonly PromptMessage[],
): { role: string; content: string }[] {
  return [{ role: 'system', content: instructions }, ...messages];
}

export function koboldCppProvider(
  options: KoboldCppOptions,
): KoboldCppProvider {
  /** The loaded model being found out, or found out, for one address. */
  let loaded: { address: string; model: Promise<LoadedModel> } | undefined;

  /** The saved address, or the reason there is none. */
  const savedAddress = (): string => {
    const address = options.address();
    if (address === '') {
      throw new ProviderError(
        'No KoboldCpp address is set. Add one in Settings > Connection.',
      );
    }
    return address;
  };

  /** Send a request to KoboldCpp, and return the response once it is accepted. */
  const send = async (
    address: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${address}${path}`, init);
    } catch (error) {
      if (init.signal?.aborted === true) throw error;
      throw networkFailure(address, error);
    }
    if (!response.ok) throw await rejection(address, response);
    return response;
  };

  /** The JSON body of a GET request. */
  const getJson = async (address: string, path: string): Promise<unknown> => {
    const response = await send(address, path, {
      headers: { Accept: 'application/json' },
    });
    try {
      return await response.json();
    } catch {
      throw new ProviderError(
        `KoboldCpp at ${address} sent back an answer to ${path} that is not JSON.`,
      );
    }
  };

  /** Ask `address` which model it has loaded, and its context length. */
  const findOut = async (address: string): Promise<LoadedModel> => {
    const [models, context] = await Promise.all([
      getJson(address, '/v1/models'),
      getJson(address, '/api/extra/true_max_context_length'),
    ]);
    const id = (models as { data?: { id?: unknown }[] } | null)?.data?.[0]?.id;
    if (typeof id !== 'string' || id === '') {
      throw new ProviderError(`KoboldCpp at ${address} has no model loaded.`);
    }
    const contextLength = (context as { value?: unknown } | null)?.value;
    if (typeof contextLength !== 'number' || contextLength <= 0) {
      throw new ProviderError(
        `KoboldCpp at ${address} did not say how long its context is.`,
      );
    }
    return { id, contextLength };
  };

  /** Remember `model` as what `address` has loaded, unless it fails. */
  const remember = (address: string, model: Promise<LoadedModel>): void => {
    const entry = { address, model };
    loaded = entry;
    model.catch(() => {
      if (loaded === entry) loaded = undefined;
    });
  };

  const loadedModel = (): Promise<LoadedModel> => {
    const address = savedAddress();
    if (loaded?.address !== address) remember(address, findOut(address));
    return (loaded as { model: Promise<LoadedModel> }).model;
  };

  /** Run `request`, and forget the loaded model if it fails: it may have changed. */
  const forgettingOnFailure = async <T>(
    request: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      if (error instanceof ProviderError) loaded = undefined;
      throw error;
    }
  };

  /** POST a chat completion request, and return the response once accepted. */
  const complete = async (
    body: object,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<{ address: string; response: Response }> => {
    const address = savedAddress();
    const model = await loadedModel();
    const response = await send(address, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify({ model: model.id, ...body }),
      ...(signal !== undefined && { signal }),
    });
    return { address, response };
  };

  return {
    loadedModel,

    check(address) {
      const model = findOut(address);
      if (address === options.address()) remember(address, model);
      return model;
    },

    forget() {
      loaded = undefined;
    },

    // The model and thinking level asked for are OpenAI's settings: KoboldCpp
    // has one model, and no level to choose.
    async *streamReply({ instructions, messages, signal }: ReplyRequest) {
      try {
        const { address, response } = await complete(
          { messages: chatMessages(instructions, messages), stream: true },
          'text/event-stream',
          signal,
        );
        if (response.body === null) {
          throw new ProviderError(
            `KoboldCpp at ${address} sent an empty response.`,
          );
        }
        try {
          for await (const data of eventData(response.body)) {
            if (data === '[DONE]') return;
            const chunk = JSON.parse(data) as StreamChunk;
            if (chunk.error !== undefined) {
              const message =
                typeof chunk.error === 'string'
                  ? chunk.error
                  : (chunk.error.message ?? 'no detail given.');
              throw new ProviderError(
                `KoboldCpp at ${address} reported an error: ${message}`,
              );
            }
            const choice = chunk.choices?.[0];
            // A thinking model's thoughts come as `reasoning_content`, which
            // is not part of the reply.
            const content = choice?.delta?.content;
            if (typeof content === 'string' && content !== '') yield content;
            // `stop` for an end or a stop sequence, `length` for a limit:
            // either way, what arrived is the reply.
            if (
              choice?.finish_reason !== undefined &&
              choice.finish_reason !== null
            ) {
              return;
            }
          }
        } catch (error) {
          if (error instanceof ProviderError || signal.aborted) throw error;
          throw networkFailure(address, error);
        }
        throw new ProviderError(
          `The connection to KoboldCpp at ${address} ended before the reply was complete. Try again.`,
        );
      } catch (error) {
        if (error instanceof ProviderError) loaded = undefined;
        throw error;
      }
    },

    structured({
      instructions,
      input,
      schemaName,
      schema,
      signal,
    }: StructuredRequest) {
      return forgettingOnFailure(async () => {
        const { address, response } = await complete(
          {
            messages: chatMessages(instructions, [
              { role: 'user', content: input },
            ]),
            stream: false,
            response_format: {
              type: 'json_schema',
              json_schema: { name: schemaName, strict: true, schema },
            },
          },
          'application/json',
          signal,
        );
        let body: Completion;
        try {
          body = (await response.json()) as Completion;
        } catch (error) {
          if (signal?.aborted === true) throw error;
          throw new ProviderError(
            `KoboldCpp at ${address} sent back a response that is not JSON.`,
          );
        }
        const text = body.choices?.[0]?.message?.content ?? '';
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ProviderError(
            `KoboldCpp at ${address} sent back an answer that is not JSON.`,
          );
        }
      });
    },

    async models() {
      return [(await forgettingOnFailure(loadedModel)).id];
    },

    reasoningEfforts() {
      return Promise.resolve([]);
    },
  };
}
