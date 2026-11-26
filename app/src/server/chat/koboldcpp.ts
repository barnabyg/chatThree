// Replies from a local model served by KoboldCpp, usually on another PC on
// the LAN, through its OpenAI-compatible chat completions endpoint. KoboldCpp
// applies the model's chat template itself. It holds one model at a time,
// which the app finds out rather than picks (see docs/adr/0001).
//
// What KoboldCpp sends was checked against a real server (issue #33): the
// stream is OpenAI's chat completions format, a thinking model's thoughts
// arrive in `reasoning_content` beside `content`, and a second request waits
// for the first rather than being refused. So the first token can take a
// long time, and a stream is always read to its end or aborted. Aborting a
// request closes its connection, which stops KoboldCpp generating; the app
// also asks KoboldCpp to abort (`POST /api/extra/abort`), in case the
// connection stalls, but only when no other request is waiting, because an
// abort stops whichever generation is running. A reply comes first: a scene
// call the app made by itself is given up for it. Node's
// `fetch` waits five minutes for the response to start, which is enough for a
// long prompt on a slow PC; no shorter timeout is set.

import {
  type ChatProvider,
  ProviderError,
  type PromptMessage,
  type ReplyRequest,
  type StructuredRequest,
  THINKING,
} from './provider.ts';
import { fillReplyPrompt } from '../../shared/replyPrompt.ts';
import { describeSchema, findJson, schemaErrors } from './json.ts';
import { type ModelProfile, presetFor } from './profiles.ts';
import { eventData } from './sse.ts';
import { stripThinking, ThinkingFilter } from './thinking.ts';

/**
 * Enough for a structured answer, with room for a thinking model to think
 * first when it is not held to the schema.
 */
export const STRUCTURED_MAX_TOKENS = 2048;

/** How long asking KoboldCpp to abort may take. */
const ABORT_TIMEOUT_MS = 2_000;

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
  /**
   * The profile of a loaded model, applied to every request. Read on every
   * request. Without it, each model gets its preset.
   */
  profile?: (modelId: string) => ModelProfile;
}

/** Request fields that `extraBody` cannot change: the app's own. */
const OWN_FIELDS = new Set(['model', 'messages', 'stream', 'response_format']);

export interface KoboldCppProvider extends ChatProvider {
  /**
   * The model loaded at the saved address. Found out once and remembered for
   * the session, until the address changes or a request fails.
   * Throws `ProviderError` when it cannot be found out.
   */
  loadedModel(): Promise<LoadedModel>;
  /** The loaded model, if it has been found out: never waits. */
  knownModel(): LoadedModel | undefined;
  /** The profile of model `id`, as requests use it. */
  profileOf(id: string): ModelProfile;
  /**
   * How many tokens `text` is to the loaded model, by KoboldCpp's own count.
   * Throws `ProviderError` when it cannot be counted.
   */
  countTokens(text: string, signal?: AbortSignal): Promise<number>;
  /**
   * Stop every request in progress, and wait until KoboldCpp has been asked
   * to stop generating. Never throws.
   */
  stopAll(): Promise<void>;
  /**
   * Ask `address` now which model it has loaded. Remembered when `address`
   * is the saved one. Throws `ProviderError` when it cannot be found out.
   */
  check(address: string): Promise<LoadedModel>;
  /** Forget the loaded model, so that the next request finds it out again. */
  forget(): void;
  /**
   * Forget the loaded model, and find it out again now so that the next
   * request need not wait. A failure is reported by that request instead.
   */
  refresh(): void;
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

/** KoboldCpp's refusal of a request, with its status. */
class KoboldCppRejection extends ProviderError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What KoboldCpp says went wrong, from a response that is not OK. */
async function rejection(
  address: string,
  response: Response,
): Promise<ProviderError> {
  if (response.status === 401) {
    return new KoboldCppRejection(
      401,
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
  return new KoboldCppRejection(
    response.status,
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

/**
 * The messages of a chat completion request: the instructions first, as a
 * system message or, for a template without a system role, before the text
 * of the first user message. A conversation that starts with the character's
 * message gets a user message of its own for them.
 */
export function chatMessages(
  instructions: string,
  messages: readonly PromptMessage[],
  systemRole: ModelProfile['systemRole'],
): { role: string; content: string }[] {
  if (systemRole === 'system') {
    return [{ role: 'system', content: instructions }, ...messages];
  }
  const [first, ...rest] = messages;
  if (first?.role !== 'user') {
    return [{ role: 'user', content: instructions }, ...messages];
  }
  return [
    {
      role: 'user',
      content: `${instructions}

${first.content}`,
    },
    ...rest,
  ];
}

export function koboldCppProvider(
  options: KoboldCppOptions,
): KoboldCppProvider {
  /** The loaded model being found out, or found out, for one address. */
  let loaded:
    | {
        address: string;
        model: Promise<LoadedModel>;
        /** The model, once found out. */
        known?: LoadedModel;
      }
    | undefined;

  /** A chat completion request in progress. */
  interface Generation {
    controller: AbortController;
    background: boolean;
    /** Stopped by the app, not by whoever asked for it. */
    setAside: boolean;
  }
  const generations = new Set<Generation>();
  /** Requests to KoboldCpp to abort, still on their way. */
  const aborting = new Set<Promise<void>>();

  /** Ask KoboldCpp at the saved address to stop generating. Never throws. */
  const askToAbort = (): Promise<void> => {
    const address = options.address();
    if (address === '') return Promise.resolve();
    const asked = fetch(`${address}/api/extra/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No `genkey` is needed (#33).
      body: '{}',
      signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
    }).then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
    aborting.add(asked);
    void asked.finally(() => aborting.delete(asked));
    return asked;
  };

  /**
   * Track a request, which aborting `signal` stops, here and on KoboldCpp.
   * `end` must be called once it is over.
   */
  const begin = (
    signal: AbortSignal | undefined,
    background: boolean,
  ): { generation: Generation; end: () => void } => {
    const generation: Generation = {
      controller: new AbortController(),
      background,
      setAside: false,
    };
    const onAbort = (): void => {
      generation.controller.abort();
      // An abort stops whichever generation KoboldCpp is running, so it is
      // sent only when no other request could be the one running.
      if (generations.size === 1 && generations.has(generation)) {
        void askToAbort();
      }
    };
    generations.add(generation);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return {
      generation,
      end() {
        signal?.removeEventListener('abort', onAbort);
        generations.delete(generation);
      },
    };
  };

  /** Stop `stopping`, and KoboldCpp's generation if nothing else is waiting. */
  const setAside = async (stopping: Generation[]): Promise<void> => {
    if (stopping.length === 0) return;
    for (const generation of stopping) {
      generation.setAside = true;
      generation.controller.abort();
    }
    if ([...generations].every((generation) => stopping.includes(generation))) {
      await askToAbort();
    }
  };

  /** Give up the requests the app made by itself, so that a reply need not wait. */
  const setAsideBackground = (): Promise<void> =>
    setAside([...generations].filter(({ background }) => background));

  const profileOf = (id: string): ModelProfile =>
    options.profile?.(id) ?? presetFor(id).profile;

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
    const entry: NonNullable<typeof loaded> = { address, model };
    loaded = entry;
    model.then(
      (found) => {
        entry.known = found;
      },
      () => {
        if (loaded === entry) loaded = undefined;
      },
    );
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

  /**
   * POST a chat completion request, its body made by `build` from the loaded
   * model's profile, with the profile's `extraBody` merged in. Return the
   * response once it is accepted.
   */
  const complete = async (
    build: (profile: ModelProfile) => object,
    accept: string,
    signal: AbortSignal | undefined,
  ): Promise<{
    address: string;
    response: Response;
    profile: ModelProfile;
  }> => {
    const address = savedAddress();
    const model = await loadedModel();
    const profile = profileOf(model.id);
    const extra = Object.fromEntries(
      Object.entries(profile.extraBody).filter(
        ([field]) => !OWN_FIELDS.has(field),
      ),
    );
    const response = await send(address, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify({ model: model.id, ...build(profile), ...extra }),
      ...(signal !== undefined && { signal }),
    });
    return { address, response, profile };
  };

  /** The text of a non-streamed chat completion. */
  const answerText = async (
    build: (profile: ModelProfile) => object,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const { address, response, profile } = await complete(
      (profile) => ({ ...build(profile), stream: false }),
      'application/json',
      signal,
    );
    let completion: Completion;
    try {
      completion = (await response.json()) as Completion;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      throw new ProviderError(
        `KoboldCpp at ${address} sent back a response that is not JSON.`,
      );
    }
    // Cut off while thinking, the content can be the thinking, in its tags.
    return stripThinking(
      completion.choices?.[0]?.message?.content ?? '',
      profile.thinking,
    );
  };

  /**
   * An answer in JSON that follows the schema, checked. First the constrained
   * way: the schema goes as `response_format`, so KoboldCpp can only write
   * JSON of its shape. If KoboldCpp refuses that, the asked way: the
   * instructions describe the JSON with an example. An answer that does not
   * follow the schema either way is asked for once more, with what was
   * wrong with it.
   */
  const structured = async ({
    instructions,
    input,
    schemaName,
    schema,
    signal,
  }: StructuredRequest): Promise<unknown> => {
    // The schema's own descriptions do not reach the model (#33), so the
    // fields are described in the instructions both ways.
    const described = `${instructions}\n\n${describeSchema(schema)}`;
    const asked = `${described}\n\nAnswer with only the JSON object: no other text before or after it.`;
    const conversation: PromptMessage[] = [{ role: 'user', content: input }];
    const address = savedAddress();
    let constrained = true;
    let retried = false;
    for (;;) {
      let text: string;
      try {
        const instructionsNow = constrained ? described : asked;
        const messages = [...conversation];
        text = await answerText(
          (profile) => ({
            messages: chatMessages(
              instructionsNow,
              messages,
              profile.systemRole,
            ),
            max_tokens: STRUCTURED_MAX_TOKENS,
            temperature: profile.sceneTemperature,
            ...(constrained && {
              response_format: {
                type: 'json_schema',
                json_schema: { name: schemaName, strict: true, schema },
              },
            }),
          }),
          signal,
        );
      } catch (error) {
        // A KoboldCpp that cannot constrain its answer refuses the request.
        if (
          constrained &&
          error instanceof KoboldCppRejection &&
          (error.status === 400 || error.status === 422)
        ) {
          constrained = false;
          continue;
        }
        throw error;
      }
      const found = findJson(text);
      const errors =
        found === undefined
          ? ['the answer is not a JSON object']
          : schemaErrors(found.value, schema);
      if (found !== undefined && errors.length === 0) return found.value;
      const wrong = errors.join('; ');
      if (retried) {
        throw new ProviderError(
          `KoboldCpp at ${address} answered in a form chatThree could not use (${wrong}). Try again.`,
        );
      }
      retried = true;
      constrained = false;
      conversation.push(
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `That answer could not be used: ${wrong}. Answer again with only the JSON object, with every field.`,
        },
      );
    }
  };

  return {
    loadedModel,

    knownModel() {
      return loaded?.address === options.address() ? loaded.known : undefined;
    },

    profileOf,

    async countTokens(text, signal) {
      // Counting comes before a reply, which comes first.
      await setAsideBackground();
      const address = savedAddress();
      const response = await send(address, '/api/extra/tokencount', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ prompt: text }),
        ...(signal !== undefined && { signal }),
      });
      let count: unknown;
      try {
        count = ((await response.json()) as { value?: unknown } | null)?.value;
      } catch {
        count = undefined;
      }
      if (typeof count !== 'number' || count < 0) {
        throw new ProviderError(
          `KoboldCpp at ${address} did not say how many tokens a text is.`,
        );
      }
      return count;
    },

    check(address) {
      const model = findOut(address);
      if (address === options.address()) remember(address, model);
      return model;
    },

    forget() {
      loaded = undefined;
    },

    refresh() {
      loaded = undefined;
      if (options.address() !== '') loadedModel().catch(() => undefined);
    },

    // The model and thinking level asked for are OpenAI's settings: KoboldCpp
    // has one model, and no level to choose.
    async *streamReply({
      instructions,
      messages,
      names,
      signal,
    }: ReplyRequest) {
      await setAsideBackground();
      const { generation, end } = begin(signal, false);
      const stopping = generation.controller.signal;
      try {
        const { address, response, profile } = await complete(
          (profile) => ({
            messages: chatMessages(instructions, messages, profile.systemRole),
            stream: true,
            max_tokens: profile.maxReplyTokens,
            temperature: profile.temperature,
            top_p: profile.top_p,
            top_k: profile.top_k,
            min_p: profile.min_p,
            rep_pen: profile.rep_pen,
            rep_pen_range: profile.rep_pen_range,
            stop: profile.stop.map((stop) =>
              fillReplyPrompt(
                stop,
                names?.character ?? 'the character',
                names?.player,
              ),
            ),
          }),
          'text/event-stream',
          stopping,
        );
        if (response.body === null) {
          throw new ProviderError(
            `KoboldCpp at ${address} sent an empty response.`,
          );
        }
        const filter = new ThinkingFilter(profile.thinking);
        let thinkingShown = false;
        try {
          for await (const data of eventData(response.body)) {
            if (data === '[DONE]') {
              const rest = filter.end();
              if (rest !== '') yield rest;
              return;
            }
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
            // is not part of the reply. The filter drops thinking that comes
            // in the content, between tags.
            const reasoning = choice?.delta?.reasoning_content;
            if (typeof reasoning === 'string' && reasoning !== '') {
              filter.reasoned();
            }
            const content = choice?.delta?.content;
            const text =
              typeof content === 'string' && content !== ''
                ? filter.push(content)
                : '';
            if (filter.thinking && !thinkingShown && text === '') {
              thinkingShown = true;
              yield THINKING;
            }
            if (text !== '') {
              thinkingShown = true;
              yield text;
            }
            // `stop` for an end or a stop sequence, `length` for a limit:
            // either way, what arrived is the reply.
            if (
              choice?.finish_reason !== undefined &&
              choice.finish_reason !== null
            ) {
              const rest = filter.end();
              if (rest !== '') yield rest;
              return;
            }
          }
        } catch (error) {
          if (error instanceof ProviderError || stopping.aborted) throw error;
          throw networkFailure(address, error);
        }
        throw new ProviderError(
          `The connection to KoboldCpp at ${address} ended before the reply was complete. Try again.`,
        );
      } catch (error) {
        if (generation.setAside && !signal.aborted) {
          throw new ProviderError('The reply was stopped. Try again.');
        }
        if (error instanceof ProviderError) loaded = undefined;
        throw error;
      } finally {
        end();
      }
    },

    async structured(request: StructuredRequest) {
      const { generation, end } = begin(
        request.signal,
        request.background === true,
      );
      try {
        return await forgettingOnFailure(() =>
          structured({ ...request, signal: generation.controller.signal }),
        );
      } catch (error) {
        if (generation.setAside && request.signal?.aborted !== true) {
          throw new ProviderError(
            request.background === true
              ? 'The scene call was given up for a reply.'
              : 'The scene call was stopped. Try again.',
          );
        }
        throw error;
      } finally {
        end();
      }
    },

    async stopAll() {
      await setAside([...generations]);
      await Promise.all(aborting);
    },

    async models() {
      return [(await forgettingOnFailure(loadedModel)).id];
    },

    reasoningEfforts() {
      return Promise.resolve([]);
    },
  };
}
