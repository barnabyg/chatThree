"""Proof-of-concept measurements: each model alone, both resident, and under contention.

Run a stage with `python -m chatthree_engine.bench <speech|image|both>`. Each
stage writes its audio and images plus a `results-<stage>.json` into `out/`.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import threading
import time
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, get_args

import librosa
import torch

from chatthree_engine.audio import Speech
from chatthree_engine.cpu import run_at_full_speed
from chatthree_engine.gate import GpuGate
from chatthree_engine.image import ImageModel
from chatthree_engine.speech import SpeechModel, Variant

if TYPE_CHECKING:
    from collections.abc import Callable

    from PIL import Image

LOG = logging.getLogger("bench")
OUT = Path("out")
GIB = 2**30

REFERENCE_TEXT = (
    "This is a stand-in reference recording. It runs for several seconds so that the "
    "cloning step has enough material to work with, and it says nothing of importance at all."
)
REFERENCE_SEMITONES = -3
LINES = (
    "You're late. I was starting to think the storm had taken you.",
    "Sit down, the kettle's only just boiled.",
    "I found something in the lamp room this morning, and I don't think it was left there by accident.",
    "No, don't touch it yet!",
    "Tell me honestly: did you see anyone on the causeway when you crossed?",
    "Then we have until the tide turns, and not a minute longer.",
)
CHARACTER_PROMPT = (
    "Full-body character reference of a woman in her thirties with short silver hair, a weathered "
    "green flight jacket and a brass prosthetic left hand, plain grey studio background, soft even light."
)
LOCATION_PROMPT = (
    "Interior of a cramped lighthouse kitchen at dusk, copper pans on a rack, a round window "
    "showing a stormy sea, a small wooden table, warm lamplight, no people."
)
SCENE_PROMPT = (
    "The woman from image 1 sits at the table in the kitchen from image 2, pouring tea and looking "
    "toward the window. Keep her face, hair, jacket and brass hand unchanged. Keep the kitchen's "
    "layout and lighting unchanged."
)
SCENE_SIZE = (1152, 768)
SCENE_RUNS = 3
IMAGES_UNDER_LOAD = 4
BURST_GAP_SECONDS = 1.0


def vram() -> dict[str, float]:
    """GPU memory in GiB: this process's tensors now and at peak, its allocator's hold, and device-wide use."""
    free, total = torch.cuda.mem_get_info()
    return {
        "resident_gb": round(torch.cuda.memory_allocated() / GIB, 2),
        "peak_gb": round(torch.cuda.max_memory_allocated() / GIB, 2),
        "reserved_gb": round(torch.cuda.memory_reserved() / GIB, 2),
        "device_in_use_gb": round((total - free) / GIB, 2),
    }


def timed[T](job: Callable[[], T]) -> tuple[T, float]:
    """Run `job` and return its result with wall-clock seconds, including queued GPU work."""
    torch.cuda.synchronize()
    start = time.perf_counter()
    result = job()
    torch.cuda.synchronize()
    return result, round(time.perf_counter() - start, 3)


def unload() -> None:
    """Return freed model memory to the GPU so the next stage starts clean."""
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()


def save_clip(clip: Speech, name: str) -> None:
    """Write a clip into the output directory as a WAV file."""
    (OUT / name).write_bytes(clip.wav_bytes())


def clip_stats(text: str, clip: Speech, seconds: float) -> dict[str, float]:
    """Summarise one synthesis: below 1.0 realtime factor means faster than playback."""
    return {
        "characters": len(text),
        "latency_s": seconds,
        "audio_s": round(clip.seconds, 2),
        "realtime_factor": round(seconds / clip.seconds, 3),
    }


def reference_voice(supplied: Path | None) -> Path:
    """Return the clip to clone: the supplied one, or a synthetic stand-in.

    The stand-in is the original model's built-in voice pitched down, so the
    cloning path runs against a speaker that is not the built-in voice.
    """
    if supplied is not None:
        return supplied
    path = OUT / "reference-voice.wav"
    if not path.exists():
        model = SpeechModel("original")
        clip = model.synthesise(REFERENCE_TEXT)
        # librosa publishes no usable type information for this call.
        effects: Any = librosa.effects
        shifted = effects.pitch_shift(clip.samples, sr=clip.sample_rate, n_steps=REFERENCE_SEMITONES)
        save_clip(Speech(samples=shifted, sample_rate=clip.sample_rate), path.name)
        del model
        unload()
    return path


def bench_speech_variant(variant: Variant, voice: Path) -> dict[str, Any]:
    """Measure one Chatterbox variant alone, then release it."""
    unload()
    model, load_s = timed(partial(SpeechModel, variant))
    after_load = vram()
    _, prepare_s = timed(partial(model.prepare_voice, voice))
    clips: list[dict[str, float]] = []
    for index, line in enumerate(LINES):
        clip, seconds = timed(partial(model.synthesise, line, voice))
        save_clip(clip, f"speech-{variant}-{index}.wav")
        clips.append(clip_stats(line, clip, seconds))
    result = {
        "load_s": load_s,
        "prepare_voice_s": prepare_s,
        "vram_after_load": after_load,
        "vram_after_run": vram(),
        "clips": clips,
    }
    del model
    return result


def bench_speech(voice: Path) -> dict[str, Any]:
    """Each Chatterbox variant alone: load time, cloning time, per-sentence latency."""
    return {variant: bench_speech_variant(variant, voice) for variant in get_args(Variant)}


def make_references(model: ImageModel) -> tuple[Image.Image, Image.Image, dict[str, float]]:
    """Generate and save the character and location references from text alone."""
    character, character_s = timed(partial(model.generate, CHARACTER_PROMPT, seed=1))
    location, location_s = timed(partial(model.generate, LOCATION_PROMPT, seed=2))
    character.save(OUT / "character.png")
    location.save(OUT / "location.png")
    return character, location, {"first_image_s": character_s, "text_to_image_s": location_s}


def bench_image(*, compact: bool) -> dict[str, Any]:
    """Klein alone: load time, text-to-image, and two-reference scene generation."""
    unload()
    model, load_s = timed(partial(ImageModel, compact=compact))
    after_load = vram()
    torch.cuda.reset_peak_memory_stats()  # loading peaks above the compacted size
    character, location, reference_times = make_references(model)
    scene_seconds: list[float] = []
    for seed in range(SCENE_RUNS):
        scene, seconds = timed(partial(model.generate, SCENE_PROMPT, [character, location], size=SCENE_SIZE, seed=seed))
        scene.save(OUT / f"scene-{seed}.png")
        scene_seconds.append(seconds)
    return {
        "compact_weights": compact,
        "load_s": load_s,
        "vram_after_load": after_load,
        **reference_times,
        "two_reference_scene_s": scene_seconds,
        "vram_after_run": vram(),
    }


def speech_burst(model: SpeechModel, voice: Path, gate: GpuGate | None) -> list[dict[str, float]]:
    """Synthesise every line back to back, as the app would for one reply."""
    clips: list[dict[str, float]] = []
    for line in LINES:
        start = time.perf_counter()
        if gate is None:
            clip = model.synthesise(line, voice)
        else:
            with gate.speech():
                clip = model.synthesise(line, voice)
        clips.append(clip_stats(line, clip, round(time.perf_counter() - start, 3)))
    return clips


def contention(
    speech: SpeechModel, image: ImageModel, voice: Path, references: list[Image.Image], gate: GpuGate | None
) -> dict[str, Any]:
    """Generate images continuously while speech bursts arrive. `gate=None` shares the GPU freely."""
    image_seconds: list[float] = []
    finished = threading.Event()

    def image_worker() -> None:
        try:
            for seed in range(IMAGES_UNDER_LOAD):
                start = time.perf_counter()
                if gate is None:
                    image.generate(SCENE_PROMPT, references, size=SCENE_SIZE, seed=seed)
                else:
                    with gate.image():
                        image.generate(SCENE_PROMPT, references, size=SCENE_SIZE, seed=seed, on_step=gate.checkpoint)
                image_seconds.append(round(time.perf_counter() - start, 3))
        finally:
            finished.set()

    worker = threading.Thread(target=image_worker)
    start = time.perf_counter()
    worker.start()
    bursts: list[list[dict[str, float]]] = []
    while not finished.wait(BURST_GAP_SECONDS):
        bursts.append(speech_burst(speech, voice, gate))
    worker.join()
    return {
        "image_s": image_seconds,
        "all_images_s": round(time.perf_counter() - start, 3),
        "speech_bursts": bursts,
        "vram": vram(),
    }


def bench_both(voice: Path, variant: Variant, *, compact: bool) -> dict[str, Any]:
    """Both models resident in one process: memory, then speech latency with and without image load."""
    unload()
    speech = SpeechModel(variant)
    image = ImageModel(compact=compact)
    speech.prepare_voice(voice)
    resident = vram()
    torch.cuda.reset_peak_memory_stats()  # loading peaks above the compacted size
    character, location, _ = make_references(image)
    references = [character, location]
    speech_burst(speech, voice, None)  # warm-up, not recorded
    idle_speech = speech_burst(speech, voice, None)
    idle_image = [
        timed(partial(image.generate, SCENE_PROMPT, references, size=SCENE_SIZE, seed=seed))[1] for seed in range(2)
    ]
    return {
        "speech_variant": variant,
        "compact_weights": compact,
        "vram_both_resident": resident,
        "idle_speech": idle_speech,
        "idle_image_s": idle_image,
        "gated": contention(speech, image, voice, references, GpuGate()),
        "ungated": contention(speech, image, voice, references, None),
    }


def main() -> None:
    """Run one benchmark stage and write its results file."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["speech", "image", "both"])
    parser.add_argument("--voice", type=Path, help="reference clip to clone (default: a synthetic stand-in)")
    parser.add_argument("--variant", choices=get_args(Variant), default="turbo", help="speech model for `both`")
    parser.add_argument("--full-precision", action="store_true", help="keep image weights at 16-bit (more VRAM)")
    args = parser.parse_args()
    logging.basicConfig(format="%(message)s")
    LOG.setLevel(logging.INFO)
    OUT.mkdir(exist_ok=True)
    full_speed = run_at_full_speed()

    result: dict[str, Any]
    compact = not args.full_precision
    if args.stage == "image":
        result = bench_image(compact=compact)
    else:
        voice = reference_voice(args.voice)
        result = bench_speech(voice) if args.stage == "speech" else bench_both(voice, args.variant, compact=compact)
    result["gpu"] = torch.cuda.get_device_name(0)
    result["unthrottled_and_pinned"] = full_speed
    text = json.dumps(result, indent=2)
    (OUT / f"results-{args.stage}.json").write_text(text + "\n", encoding="utf-8")
    LOG.info(text)


if __name__ == "__main__":
    main()
