# chatThree engine

One Python process that owns the GPU and runs both local models: voice-cloning
speech (Chatterbox) and reference-image generation (FLUX.2 klein 4B). The app
will start it, wait for it to report ready, and send it jobs over a loopback
HTTP API. This is the proof of concept for that idea.

## Run it

The only prerequisite is [uv](https://docs.astral.sh/uv/) and an NVIDIA GPU with
24 GB of VRAM. The first run creates the Python environment and downloads about
18 GB of models; nothing else needs installing or configuring.

```powershell
cd C:\docs\git\chatThree\engine; uv run python -m chatthree_engine.demo
```

That writes a cloned-voice clip and a two-reference scene image into `out/`.
Pass `--voice path\to\clip.wav` (more than 5 seconds of clean speech) to clone a
real voice; without it a synthetic stand-in voice is used.

| Command | What it does |
|---|---|
| `uv run python -m chatthree_engine.demo` | One clip and one scene image, both models loaded together |
| `uv run python -m chatthree_engine.server` | The HTTP API on `127.0.0.1:8765` |
| `uv run python -m chatthree_engine.bench speech` | Both Chatterbox variants alone |
| `uv run python -m chatthree_engine.bench image` | Klein alone |
| `uv run python -m chatthree_engine.bench both` | Both resident, plus speech latency under image load |
| `pwsh ..\verify.ps1` | Every check: format, lint, types, tests, audit, build (no GPU needed) |

## HTTP API

| Request | Body | Response |
|---|---|---|
| `GET /health` | | `{"status": "loading" \| "ready" \| "failed", "error": ...}` |
| `POST /speech` | `{"text", "voice"?}` | `audio/wav`, with an `X-Audio-Seconds` header |
| `POST /image` | `{"prompt", "references"?, "width"?, "height"?, "seed"?}` | `image/png` |

`voice` and `references` are file paths on this machine, which is why the server
only listens on the loopback address. Jobs sent before the models are in get a
503.

## Results

Measured on an RTX 4090 (24 GB) and i7-12700K, Windows 11, with a desktop using
about 1.5 GB of VRAM.

| Measurement | Result |
|---|---|
| Speech, Chatterbox Turbo | 0.4–1.2 s per sentence, about 0.3× the clip's length |
| Speech VRAM | 2.7 GB |
| Cloning a new voice | about 2.5 s, once per voice |
| Text-to-image, 1024×1024 | 1.4 s |
| Scene from two references, 1152×768 | 4.3 s |
| Image VRAM | 11.3 GB resident, 13.7 GB peak |
| Both models resident | 13.9 GB, 16.3 GB peak while both are working |
| Device-wide VRAM between jobs | 16.0 GB of 24.6 GB |
| First sentence of a reply while an image generates | 1.2–1.9 s (0.95 s idle) |
| Later sentences while an image generates | unchanged |
| Process start to `ready` | about 45 s |
| Fresh clone to finished demo, downloads cached | 125 s |

The original (non-Turbo) Chatterbox model also works and uses 3.1 GB, but is
roughly half the speed.

Speech has priority. An image job gives up the GPU between denoising steps
whenever speech is waiting, so an image takes longer in proportion to how much
speech is requested during it. Without that scheduling the first sentence
waited 17 s behind the image queue.

## What it took to make one environment work

- **Chatterbox's pins.** `chatterbox-tts` 0.1.7 pins exact, old versions of
  diffusers, safetensors, torch and transformers. `pyproject.toml` overrides
  them. Its pinned transformers (5.2.0) has known security advisories; both
  models were re-benchmarked on 5.24.0 and the speech transcribed back correctly.
- **A missing dependency.** Chatterbox's watermarker imports `pkg_resources`
  without declaring setuptools, and fails silently (the model then crashes on
  load). setuptools is pinned below 81, the last line that ships it. That leaves
  two setuptools advisories, recorded as exceptions in `verify.ps1`.
- **An unused dependency.** Chatterbox depends on gradio for its demos only. It
  is excluded, because it held the HTTP stack at old versions.
- **Pinned model revisions.** `models.py` pins each model repository to a
  commit. On Windows without Developer Mode the Hugging Face cache cannot
  de-duplicate files, so an unpinned model re-downloads every multi-gigabyte
  file whenever its repository changes at all.
- **Memory.** At full precision the two models held 17.5 GB, the card reached
  its 24 GB limit and image time doubled. The image transformer's weights are
  now stored as 8-bit floats, and each image job returns its working memory to
  the driver when it ends.
- **Yielding the GPU.** PyTorch queues GPU work asynchronously, so the
  "end of step" callback fired before the step had run. Each step is now
  synchronised before the scheduler is asked whether speech is waiting.
- **Windows background throttling.** Windows slows a windowless process and, on
  a hybrid CPU, parks it on efficiency cores. That roughly halved Chatterbox's
  speed, so the engine opts out of throttling and pins itself to the fast cores.

## Known gaps

- **Voice quality is unheard.** The speech was checked by transcribing it, not
  by listening, and the cloning ran against a synthetic stand-in voice.
- **No streaming.** A sentence is returned whole, so the delay before audio
  starts is the full synthesis time. The app must split replies into sentences.
- **Stopping the engine.** On Windows, killing the launcher leaves the Python
  process running. The app's supervisor must end the whole process tree.
- **Image limits.** Only klein 4B was tested. The character reference came out
  with two brass hands when one was asked for, and scenes with two characters
  (three references) were not tried.
- **Further memory headroom.** Storing the text encoder as 8-bit floats saved
  another 3.7 GB in a test, but needed a private pipeline method, so it is not
  enabled.
- **First run on a new machine.** The 18 GB model download took about 35
  minutes here and has no progress reporting beyond the console.
- **Upstream deprecations.** Chatterbox uses a diffusers class due for removal
  in diffusers 1.0, and `pkg_resources` is already gone from current setuptools.
