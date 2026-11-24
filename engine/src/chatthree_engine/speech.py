"""Voice-cloning speech synthesis, backed by Chatterbox."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import torch
from chatterbox.tts import ChatterboxTTS
from chatterbox.tts_turbo import ChatterboxTurboTTS

from chatthree_engine.audio import Speech
from chatthree_engine.models import CHATTERBOX, CHATTERBOX_TURBO, fetch

if TYPE_CHECKING:
    from pathlib import Path

Variant = Literal["turbo", "original"]


class SpeechModel:
    """A loaded Chatterbox model plus a cache of prepared voices.

    Preparing a voice from its reference clip costs far more than selecting an
    already prepared one, so each clip is prepared once and reused.
    """

    def __init__(self, variant: Variant = "turbo", device: str = "cuda") -> None:
        self.variant: Variant = variant
        # Chatterbox ships no type information, so the model is opaque here.
        loader: Any = ChatterboxTurboTTS if variant == "turbo" else ChatterboxTTS
        pin = CHATTERBOX_TURBO if variant == "turbo" else CHATTERBOX
        self._model: Any = loader.from_local(fetch(pin), device)
        self._built_in_voice: Any = self._model.conds
        self._voices: dict[Path, Any] = {}

    @property
    def sample_rate(self) -> int:
        """Output sample rate in hertz."""
        return int(self._model.sr)

    def has_voice(self, voice: Path) -> bool:
        """Whether the voice in this clip is already prepared."""
        return voice.resolve() in self._voices

    def prepare_voice(self, voice: Path) -> None:
        """Clone a voice from a reference clip (Turbo needs more than 5 seconds).

        A voice is remembered by its clip's path, so a clip that changes needs a new path.
        """
        key = voice.resolve()
        if key in self._voices:
            return
        try:
            with torch.inference_mode():
                self._model.prepare_conditionals(str(key))
        except AssertionError as error:
            # Chatterbox asserts on a clip it cannot clone from, such as one that is too short.
            raise ValueError(str(error)) from error
        self._voices[key] = self._model.conds

    def synthesise(self, text: str, voice: Path | None = None) -> Speech:
        """Speak `text` in the cloned `voice`, or the built-in voice when None."""
        if voice is None:
            if self._built_in_voice is None:
                msg = f"The {self.variant} model has no built-in voice; pass a reference clip."
                raise ValueError(msg)
            self._model.conds = self._built_in_voice
        else:
            self.prepare_voice(voice)
            self._model.conds = self._voices[voice.resolve()]
        with torch.inference_mode():
            wav = self._model.generate(text)
        samples = wav.squeeze(0).cpu().numpy().astype(np.float32)
        return Speech(samples=samples, sample_rate=self.sample_rate)
