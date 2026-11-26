# Glossary

Terms as they are used in chatThree's code, issues and docs.

**Text backend**
: The service that writes all of the app's text: the replies and the scene
  call. Either OpenAI or KoboldCpp, chosen in Settings > Connection. Not
  chosen per call. See [ADR 0001](docs/adr/0001-local-text-via-koboldcpp.md).

**Loaded model**
: The one model KoboldCpp has loaded, which writes everything while KoboldCpp
  is the text backend. The app finds it out from KoboldCpp; the user does not
  pick it. Its id is `koboldcpp/` and the GGUF file's name, such as
  `koboldcpp/gemma-4-31B-it-Q4_K_S`.

**Model profile**
: The settings that belong to one local model: samplers, reply length, stop
  sequences, system role, thinking and extra request fields. Keyed by the
  loaded model's id, and made of its preset with the user's overrides on top.
  See [ADR 0002](docs/adr/0002-model-profiles.md).

**Preset**
: A model profile that ships with the app for a family of models (Qwen3,
  Gemma...), matched to model ids by a pattern. Generic matches every model
  that no other preset does.

**Overrides**
: The fields of a model profile the user has changed, and only those, kept
  per model id in `local-models.json` in the data directory.

**Scene call**
: The structured request that reads the latest messages and describes the
  moment as a picture, and says where the story is. Made by the text backend.
