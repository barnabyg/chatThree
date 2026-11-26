// The text backend: which provider writes the replies and the scene call.
// It is read from the settings on every request, so that a change in
// Settings takes effect without a restart.

import type { TextBackend } from '../../shared/api.ts';
import type { ChatProvider } from './provider.ts';

/** A provider that hands each request to the provider of the chosen backend. */
export function backendProvider(
  backend: () => TextBackend,
  providers: Record<TextBackend, ChatProvider>,
): ChatProvider {
  const current = (): ChatProvider => providers[backend()];
  return {
    streamReply: (request) => current().streamReply(request),
    structured: (request) => current().structured(request),
    models: () => current().models(),
    reasoningEfforts: (model) => current().reasoningEfforts(model),
  };
}
