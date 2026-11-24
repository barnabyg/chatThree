"""Local HTTP API over the engine: one process owns the GPU and both models.

The app starts this process, polls `/health` until it reports `ready`, then
posts speech and image jobs. Voices and reference images are passed as paths
on this machine, so the server must only ever listen on the loopback address.
"""

import argparse
import io
import threading
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from PIL import Image
from pydantic import BaseModel, Field

from chatthree_engine.audio import MIN_VOICE_SECONDS, Speech, clip_seconds
from chatthree_engine.cpu import run_at_full_speed
from chatthree_engine.gate import GpuGate

LOOPBACK = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_SPEECH_CHARACTERS = 600
MAX_REFERENCES = 4
SIDE_STEP = 16
HTTP_NO_CONTENT = 204
HTTP_BAD_REQUEST = 400
HTTP_UNAVAILABLE = 503


class Synthesiser(Protocol):
    """What the API needs from a speech model."""

    def has_voice(self, voice: Path) -> bool:
        """Whether the voice in this clip is already prepared."""
        ...

    def prepare_voice(self, voice: Path) -> None:
        """Clone the voice in this clip, so that speaking in it later does not wait for that."""
        ...

    def synthesise(self, text: str, voice: Path | None = None) -> Speech:
        """Speak `text` in the cloned `voice`, or the built-in voice when None."""
        ...


class Painter(Protocol):
    """What the API needs from an image model."""

    def generate(
        self,
        prompt: str,
        references: Sequence[Image.Image] = (),
        *,
        size: tuple[int, int] = (1024, 1024),
        seed: int = 0,
        on_step: Callable[[], None] | None = None,
    ) -> Image.Image:
        """Generate one image, calling `on_step` after every denoising step."""
        ...


@dataclass
class Engine:
    """Both loaded models and the gate that shares the GPU between them."""

    speech: Synthesiser
    image: Painter
    gate: GpuGate = field(default_factory=GpuGate)


def load_engine() -> Engine:
    """Load the real models. Imported lazily so the API can be tested without a GPU."""
    from chatthree_engine.image import ImageModel  # noqa: PLC0415 - loads torch and diffusers
    from chatthree_engine.speech import SpeechModel  # noqa: PLC0415 - loads torch and Chatterbox

    return Engine(speech=SpeechModel("turbo"), image=ImageModel())


class Health(BaseModel):
    """Engine readiness, for the app's supervisor to poll."""

    status: Literal["loading", "ready", "failed"]
    error: str | None = None


class SpeechRequest(BaseModel):
    """One sentence or short passage to speak."""

    text: str = Field(min_length=1, max_length=MAX_SPEECH_CHARACTERS)
    voice: Path | None = Field(default=None, description="Reference clip to clone; built-in voice when omitted.")


class VoiceRequest(BaseModel):
    """One voice to prepare ahead of the first sentence spoken in it."""

    voice: Path = Field(description="Reference clip to clone.")


class ImageRequest(BaseModel):
    """One image to generate, optionally steered by reference images."""

    prompt: str = Field(min_length=1)
    references: list[Path] = Field(default_factory=list[Path], max_length=MAX_REFERENCES)
    width: int = Field(default=1024, ge=256, le=2048, multiple_of=SIDE_STEP)
    height: int = Field(default=1024, ge=256, le=2048, multiple_of=SIDE_STEP)
    seed: int = 0


class _Loading:
    """Loads the engine on a background thread so `/health` answers straight away."""

    def __init__(self, loader: Callable[[], Engine]) -> None:
        self._loader = loader
        self._engine: Engine | None = None
        self._error: str | None = None
        self._thread = threading.Thread(target=self._load, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _load(self) -> None:
        try:
            self._engine = self._loader()
        except Exception as error:  # noqa: BLE001 - any load failure must surface through /health
            self._error = f"{type(error).__name__}: {error}"

    def health(self) -> Health:
        if self._error is not None:
            return Health(status="failed", error=self._error)
        return Health(status="ready" if self._engine is not None else "loading")

    def engine(self) -> Engine:
        if self._engine is None:
            raise HTTPException(HTTP_UNAVAILABLE, detail=self.health().model_dump())
        return self._engine


def _existing(path: Path, what: str) -> Path:
    if not path.is_file():
        raise HTTPException(HTTP_BAD_REQUEST, detail=f"{what} not found: {path}")
    return path


def _voice_clip(path: Path) -> Path:
    """Check that a voice can be cloned from the clip at `path`, or refuse the request."""
    _existing(path, "voice clip")
    try:
        seconds = clip_seconds(path)
    except ValueError as error:
        raise HTTPException(HTTP_BAD_REQUEST, detail=str(error)) from error
    if seconds <= MIN_VOICE_SECONDS:
        detail = (
            f"The voice clip is {seconds:.1f} seconds long. "
            f"It must be longer than {MIN_VOICE_SECONDS:g} seconds to clone a voice from."
        )
        raise HTTPException(HTTP_BAD_REQUEST, detail=detail)
    return path


def create_app(loader: Callable[[], Engine] = load_engine) -> FastAPI:
    """Build the API. `loader` supplies the models, so tests can pass fakes."""
    loading = _Loading(loader)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        loading.start()
        yield

    app = FastAPI(title="chatThree engine", lifespan=lifespan)

    @app.get("/health")
    def health() -> Health:  # pyright: ignore[reportUnusedFunction] - registered by the decorator
        return loading.health()

    @app.post("/speech", response_class=Response, responses={200: {"content": {"audio/wav": {}}}})
    def speech(request: SpeechRequest) -> Response:  # pyright: ignore[reportUnusedFunction] - registered by the decorator
        engine = loading.engine()
        voice = None if request.voice is None else _voice_clip(request.voice)
        try:
            with engine.gate.speech():
                clip = engine.speech.synthesise(request.text, voice)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, detail=str(error)) from error
        return Response(clip.wav_bytes(), media_type="audio/wav", headers={"X-Audio-Seconds": f"{clip.seconds:.2f}"})

    # Cloning a voice takes seconds, so the app asks for it when a chat opens
    # and the first sentence spoken in that voice does not have to wait.
    @app.post("/voice", status_code=HTTP_NO_CONTENT)
    def voice(request: VoiceRequest) -> None:  # pyright: ignore[reportUnusedFunction] - registered by the decorator
        engine = loading.engine()
        clip = _voice_clip(request.voice)
        # A voice that is already prepared needs no GPU, so it does not queue for one.
        if engine.speech.has_voice(clip):
            return
        try:
            with engine.gate.speech():
                engine.speech.prepare_voice(clip)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, detail=str(error)) from error

    @app.post("/image", response_class=Response, responses={200: {"content": {"image/png": {}}}})
    def image(request: ImageRequest) -> Response:  # pyright: ignore[reportUnusedFunction] - registered by the decorator
        engine = loading.engine()
        references = [Image.open(_existing(path, "reference image")).convert("RGB") for path in request.references]
        with engine.gate.image():
            picture = engine.image.generate(
                request.prompt,
                references,
                size=(request.width, request.height),
                seed=request.seed,
                on_step=engine.gate.checkpoint,
            )
        buffer = io.BytesIO()
        picture.save(buffer, format="PNG")
        return Response(buffer.getvalue(), media_type="image/png")

    return app


def main() -> None:
    """Serve the engine on the loopback address."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    run_at_full_speed()
    uvicorn.run(create_app(), host=LOOPBACK, port=args.port)


if __name__ == "__main__":
    main()
