# 2. Model profiles: a preset plus the user's overrides

Date: 2026-11-26

## Status

Accepted

## Context

Local models differ in what they need: samplers, reply length, stop
sequences, whether their template has a system role, and whether they think
before answering. The user loads whichever GGUF they like into KoboldCpp
(see [ADR 0001](0001-local-text-via-koboldcpp.md)), and the app should work
with it without setting anything up first. Some users will still want to tune
a model.

## Decision

Each local model gets a **model profile**, keyed by the model id KoboldCpp
reports (`koboldcpp/` and the GGUF file's name). A profile is a **preset**
plus the user's **overrides**:

- **Presets ship with the app**, in `app/src/server/chat/profiles.ts`. Each
  is matched to model ids by a pattern, tested without the `koboldcpp/`
  prefix and the quantisation suffix, ignoring case. The first match wins:
  DeepSeek R1 distills, Qwen3, Mistral / Mistral Nemo, Gemma, Llama 3, and
  Generic last, matching everything. Every preset has a value for every
  field.
- **Overrides are only the fields the user changed**, per model id, in
  `local-models.json` in the data directory. They take precedence over the
  preset field by field. A field that is not valid is ignored with a warning;
  a missing or unreadable file means no overrides.

A model seen for the first time gets its preset, with nothing to set up.

## Consequences

- A better preset in a later version still reaches every field the user has
  not changed, because the user's file never holds a copy of the preset.
- Overrides are tied to the exact model id, so a different quantisation of
  the same model is a different model to tune, though it gets the same
  preset.
- Until the profile editor exists, overrides are edited by hand. The file is
  read again when it changes, so an edit takes effect on the next request.
- `extraBody` lets the user send KoboldCpp fields the app does not know
  about, such as `"reasoning_effort": "none"` to cut a thinking model's
  thinking short, without a change to the app. It cannot change the model,
  the messages, streaming or the response format.
