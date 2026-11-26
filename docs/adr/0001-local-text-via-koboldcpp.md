# 1. Local text via KoboldCpp

Date: 2026-11-26

## Status

Accepted

## Context

All of the app's text, the replies and the scene call, came from OpenAI. The
user wants the option of a local model instead. The engine already fills this
PC's VRAM with the image and voice models, so the local model runs on another
PC on the LAN, served by KoboldCpp. How a real KoboldCpp behaves was checked
first (issue #33).

## Decision

- **One text backend for every text call**: OpenAI or KoboldCpp, chosen in
  Settings > Connection, not chosen per call. KoboldCpp holds one model at a
  time, so the reply and the scene call both use whichever model is loaded.
  The backend is read from the settings on each request, so a change takes
  effect without a restart. Settings saved before the choice existed load as
  OpenAI.
- **KoboldCpp only.** No other OpenAI-compatible server is supported, so
  KoboldCpp's own endpoints (`/api/extra/...`) can be used where they help.
  It is a `ChatProvider` of its own (`app/src/server/chat/koboldcpp.ts`): the
  OpenAI provider uses the Responses API, which KoboldCpp does not serve.
- **The app finds out which model is loaded; the user does not pick one.** It
  asks `GET /v1/models` and `GET /api/extra/true_max_context_length` at
  startup, when the connection settings are saved or tested, and after a
  failed request, and remembers the answer for the session otherwise. The
  OpenAI model and thinking-level settings are hidden while KoboldCpp is
  chosen, and kept for when OpenAI is chosen again.
- **KoboldCpp applies the chat template**: requests go to
  `POST /v1/chat/completions`, with the instructions as a `system` message.
  Templating in the app through `/v1/completions` is a fallback to build only
  if a model the user runs comes out wrong.
- **No KoboldCpp password.** The epic planned a password setting of its own.
  The check (#33) found the user runs KoboldCpp without `--password` on a
  private network, and a password could not be tested against the real
  server, so it was left out. A server that asks for one gets an error that
  says to start KoboldCpp without it.
- **The OpenAI key is never sent to KoboldCpp.** Pointing `OPENAI_BASE_URL` at
  KoboldCpp would have done exactly that, which is one more reason for a
  provider of its own.

## Consequences

- Every error while KoboldCpp is the backend names KoboldCpp and its address.
- KoboldCpp queues a second request behind the first rather than refusing it,
  and a long prompt can take tens of seconds before the first token. No
  timeout shorter than Node's five minutes is set, and a stream is always read
  to its end or aborted.
- KoboldCpp sends plain HTTP on the LAN: what is said in chats crosses the
  network unencrypted.
