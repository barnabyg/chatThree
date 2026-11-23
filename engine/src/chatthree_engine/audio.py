"""Audio clips produced by the engine. Kept free of model imports so it loads instantly."""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import soundfile

if TYPE_CHECKING:
    import numpy as np
    import numpy.typing as npt


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
