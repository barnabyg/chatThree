"""Audio clips produced by the engine. Kept free of model imports so it loads instantly."""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import soundfile

if TYPE_CHECKING:
    from pathlib import Path

    import numpy as np
    import numpy.typing as npt

# Chatterbox refuses to clone a voice from a clip of 5 seconds or less.
MIN_VOICE_SECONDS = 5.0


def clip_seconds(clip: Path) -> float:
    """Length of the recording in `clip`, or ValueError if it cannot be read as audio."""
    # soundfile publishes no usable type information for this call.
    info: Any = soundfile.info
    try:
        details = info(str(clip))
    except soundfile.LibsndfileError as error:
        msg = f"The voice clip is not a recording the engine can read: {clip}"
        raise ValueError(msg) from error
    return float(details.frames) / float(details.samplerate)


@dataclass(frozen=True)
class Speech:
    """One synthesised clip: mono float32 samples in the range -1..1."""

    samples: npt.NDArray[np.float32]
    sample_rate: int

    @property
    def seconds(self) -> float:
        """Clip length in seconds."""
        return len(self.samples) / self.sample_rate

    def wav_bytes(self) -> bytes:
        """Encode the clip as a 16-bit PCM WAV file."""
        buffer = io.BytesIO()
        # soundfile publishes no usable type information for this call.
        write: Any = soundfile.write
        write(buffer, self.samples, self.sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue()
