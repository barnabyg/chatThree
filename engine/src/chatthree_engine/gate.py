"""Single-GPU scheduling: one job on the GPU at a time, speech ahead of images.

Speech has to feel immediate while an image takes seconds, so an image job
gives up the GPU between denoising steps whenever speech is waiting.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Generator


class GpuGate:
    """Mutual exclusion for the GPU with priority for speech jobs."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._busy = False
        self._speech_waiting = 0

    @property
    def speech_waiting(self) -> int:
        """Number of speech jobs currently queued for the GPU."""
        with self._cond:
            return self._speech_waiting

    @contextmanager
    def speech(self) -> Generator[None]:
        """Hold the GPU for one speech job, ahead of any waiting image job."""
        with self._cond:
            self._speech_waiting += 1
            try:
                while self._busy:
                    self._cond.wait()
            finally:
                self._speech_waiting -= 1
            self._busy = True
        try:
            yield
        finally:
            self._release()

    @contextmanager
    def image(self) -> Generator[None]:
        """Hold the GPU for one image job, starting only when no speech is waiting."""
        with self._cond:
            self._wait_until_free_of_speech()
            self._busy = True
        try:
            yield
        finally:
            self._release()

    def checkpoint(self) -> None:
        """Let waiting speech run. Call between denoising steps while holding `image()`."""
        with self._cond:
            if self._speech_waiting == 0:
                return
            self._busy = False
            self._cond.notify_all()
            self._wait_until_free_of_speech()
            self._busy = True

    def _wait_until_free_of_speech(self) -> None:
        while self._busy or self._speech_waiting > 0:
            self._cond.wait()

    def _release(self) -> None:
        with self._cond:
            self._busy = False
            self._cond.notify_all()
