// Reading a server-sent event stream, as OpenAI and KoboldCpp both send them.

/**
 * The data of each event in `body`, in order, `[DONE]` included. Events are
 * separated by a blank line, and an event's `data:` lines are joined.
 */
export async function* eventData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let buffer = '';
  const text = body.pipeThrough(new TextDecoderStream());
  for await (const chunk of text) {
    buffer += chunk;
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (data !== '') yield data;
    }
  }
}
