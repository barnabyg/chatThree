"""The HTTP API, driven through real requests against fake models (no GPU needed)."""

import io
import threading
import time
from collections.abc import Callable, Generator, Sequence
from pathlib import Path

import numpy as np
import pytest
import soundfile
from fastapi.testclient import TestClient
from PIL import Image

from chatthree_engine.audio import Speech
from chatthree_engine.server import Engine, create_app

SAMPLE_RATE = 24_000
WAIT = 5.0


class FakeSpeech:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Path | None]] = []

    def synthesise(self, text: str, voice: Path | None = None) -> Speech:
        self.calls.append((text, voice))
        return Speech(samples=np.zeros(SAMPLE_RATE // 2, dtype=np.float32), sample_rate=SAMPLE_RATE)


class FakeImage:
    def __init__(self) -> None:
        self.reference_sizes: list[tuple[int, int]] = []
        self.steps = 0

    def generate(
        self,
        prompt: str,
        references: Sequence[Image.Image] = (),
        *,
        size: tuple[int, int] = (1024, 1024),
        seed: int = 0,
        on_step: Callable[[], None] | None = None,
    ) -> Image.Image:
        del prompt, seed
        self.reference_sizes = [reference.size for reference in references]
        for _ in range(4):
            self.steps += 1
            if on_step is not None:
                on_step()
        return Image.new("RGB", size, "teal")


def wait_for_status(client: TestClient, wanted: str) -> None:
    deadline = time.monotonic() + WAIT
    while client.get("/health").json()["status"] != wanted:
        assert time.monotonic() < deadline


@pytest.fixture
def fakes() -> tuple[FakeSpeech, FakeImage]:
    return FakeSpeech(), FakeImage()


@pytest.fixture
def client(fakes: tuple[FakeSpeech, FakeImage]) -> Generator[TestClient]:
    engine = Engine(speech=fakes[0], image=fakes[1])
    with TestClient(create_app(lambda: engine)) as test_client:
        wait_for_status(test_client, "ready")
        yield test_client


def test_health_reports_loading_until_the_models_are_in() -> None:
    release = threading.Event()

    def slow_loader() -> Engine:
        assert release.wait(WAIT)
        return Engine(speech=FakeSpeech(), image=FakeImage())

    with TestClient(create_app(slow_loader)) as client:
        assert client.get("/health").json() == {"status": "loading", "error": None}
        assert client.post("/speech", json={"text": "hello"}).status_code == 503
        release.set()
        wait_for_status(client, "ready")


def test_health_reports_a_failed_load() -> None:
    def broken_loader() -> Engine:
        message = "out of memory"
        raise RuntimeError(message)

    with TestClient(create_app(broken_loader)) as client:
        wait_for_status(client, "failed")
        assert client.get("/health").json() == {"status": "failed", "error": "RuntimeError: out of memory"}


def test_speech_returns_a_playable_wav(client: TestClient, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path) -> None:
    voice = tmp_path / "voice.wav"
    voice.write_bytes(b"reference")

    response = client.post("/speech", json={"text": "Sit down.", "voice": str(voice)})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-audio-seconds"] == "0.50"
    info = soundfile.info(io.BytesIO(response.content))
    assert (info.samplerate, info.frames) == (SAMPLE_RATE, SAMPLE_RATE // 2)
    assert fakes[0].calls == [("Sit down.", voice)]


def test_speech_rejects_a_missing_voice_clip(client: TestClient, tmp_path: Path) -> None:
    response = client.post("/speech", json={"text": "Sit down.", "voice": str(tmp_path / "absent.wav")})

    assert response.status_code == 400
    assert "voice clip not found" in response.json()["detail"]


def test_image_returns_a_png_and_passes_references_through(
    client: TestClient, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path
) -> None:
    character = tmp_path / "character.png"
    location = tmp_path / "location.png"
    Image.new("RGB", (64, 96)).save(character)
    Image.new("RGB", (128, 80)).save(location)

    response = client.post(
        "/image",
        json={"prompt": "tea", "references": [str(character), str(location)], "width": 512, "height": 384},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(response.content)).size == (512, 384)
    assert fakes[1].reference_sizes == [(64, 96), (128, 80)]
    assert fakes[1].steps == 4


def test_image_rejects_sizes_the_model_cannot_produce(client: TestClient) -> None:
    assert client.post("/image", json={"prompt": "tea", "width": 1000}).status_code == 422


def test_image_rejects_a_missing_reference(client: TestClient, tmp_path: Path) -> None:
    response = client.post("/image", json={"prompt": "tea", "references": [str(tmp_path / "absent.png")]})

    assert response.status_code == 400
    assert "reference image not found" in response.json()["detail"]
