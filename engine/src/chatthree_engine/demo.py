"""Smallest end-to-end run: one cloned-voice clip and one two-reference image.

Run it with `uv run python -m chatthree_engine.demo`. On a machine that has
never run the engine this also creates the Python environment and downloads
the pinned models, with no other setup.
"""

from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

from chatthree_engine.bench import (
    LINES,
    OUT,
    SCENE_PROMPT,
    SCENE_SIZE,
    make_references,
    reference_voice,
    save_clip,
)
from chatthree_engine.cpu import run_at_full_speed
from chatthree_engine.image import ImageModel
from chatthree_engine.speech import SpeechModel

LOG = logging.getLogger("demo")


def main() -> None:
    """Produce `out/demo-speech.wav` and `out/demo-scene.png` with both models loaded together."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", type=Path, help="reference clip to clone (default: a synthetic stand-in)")
    args = parser.parse_args()
    logging.basicConfig(format="%(message)s")
    LOG.setLevel(logging.INFO)
    OUT.mkdir(exist_ok=True)
    run_at_full_speed()

    start = time.perf_counter()
    voice = reference_voice(args.voice)
    speech = SpeechModel("turbo")
    image = ImageModel()
    LOG.info("Both models loaded after %.0f s", time.perf_counter() - start)

    save_clip(speech.synthesise(LINES[0], voice), "demo-speech.wav")
    character, location, _ = make_references(image)
    image.generate(SCENE_PROMPT, [character, location], size=SCENE_SIZE).save(OUT / "demo-scene.png")
    LOG.info("Finished after %.0f s", time.perf_counter() - start)
    for name in ("demo-speech.wav", "character.png", "location.png", "demo-scene.png"):
        LOG.info("  %s", (OUT / name).resolve())


if __name__ == "__main__":
    main()
