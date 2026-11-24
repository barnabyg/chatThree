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
        self.prepared: list[Path] = []

    def has_voice(self, voice: Path) -> bool:
        return voice in self.prepared

    def prepare_voice(self, voice: Path) -> None:
        self.prepared.append(voice)

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


def voice_clip(folder: Path, seconds: float = 6.0) -> Path:
    """Write a silent recording of the given length and return its path."""
    path = folder / f"voice-{seconds}.wav"
    soundfile.write(path, np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32), SAMPLE_RATE)
    return path


def wait_for_status(client: TestClient, wanted: str) -> None:
    deadline = time.monotonic() + WAIT
    while client.get("/health").json()["status"] != wanted:
        assert time.monotonic() < deadline


@pytest.fixture
def fakes() -> tuple[FakeSpeech, FakeImage]:
    return FakeSpeech(), FakeImage()


@pytest.fixture
def engine(fakes: tuple[FakeSpeech, FakeImage]) -> Engine:
    return Engine(speech=fakes[0], image=fakes[1])


@pytest.fixture
def client(engine: Engine) -> Generator[TestClient]:
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
    voice = voice_clip(tmp_path)

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


def test_speech_rejects_a_voice_clip_too_short_to_clone_from(client: TestClient, tmp_path: Path) -> None:
    response = client.post("/speech", json={"text": "Sit down.", "voice": str(voice_clip(tmp_path, seconds=2.0))})

    assert response.status_code == 400
    assert "longer than 5 seconds" in response.json()["detail"]


def test_voice_returns_once_the_voice_is_prepared(
    client: TestClient, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path
) -> None:
    voice = voice_clip(tmp_path)

    response = client.post("/voice", json={"voice": str(voice)})

    assert response.status_code == 204
    assert fakes[0].prepared == [voice]


def test_voice_takes_its_turn_on_the_gpu_as_a_speech_job(
    client: TestClient, engine: Engine, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path
) -> None:
    voice = voice_clip(tmp_path)
    statuses: list[int] = []

    def prepare() -> None:
        statuses.append(client.post("/voice", json={"voice": str(voice)}).status_code)

    request = threading.Thread(target=prepare)
    with engine.gate.image():
        request.start()
        # The request queues as speech behind the image job that holds the GPU.
        deadline = time.monotonic() + WAIT
        while engine.gate.speech_waiting == 0:
            assert time.monotonic() < deadline
        assert fakes[0].prepared == []
        # The image job's next step lets it in, as it would a sentence to speak.
        engine.gate.checkpoint()
        assert fakes[0].prepared == [voice]
    request.join(WAIT)
    assert statuses == [204]


def test_voice_already_prepared_returns_without_waiting_for_the_gpu(
    client: TestClient, engine: Engine, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path
) -> None:
    voice = voice_clip(tmp_path)
    assert client.post("/voice", json={"voice": str(voice)}).status_code == 204

    with engine.gate.image():
        response = client.post("/voice", json={"voice": str(voice)})

    assert response.status_code == 204
    assert fakes[0].prepared == [voice]


def test_voice_rejects_a_missing_clip(client: TestClient, tmp_path: Path) -> None:
    response = client.post("/voice", json={"voice": str(tmp_path / "absent.wav")})

    assert response.status_code == 400
    assert "voice clip not found" in response.json()["detail"]


def test_voice_rejects_a_clip_too_short_to_clone_from(
    client: TestClient, fakes: tuple[FakeSpeech, FakeImage], tmp_path: Path
) -> None:
    response = client.post("/voice", json={"voice": str(voice_clip(tmp_path, seconds=2.0))})

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "The voice clip is 2.0 seconds long. It must be longer than 5 seconds to clone a voice from."
    )
    assert fakes[0].prepared == []


def test_voice_rejects_a_file_that_is_not_a_recording(client: TestClient, tmp_path: Path) -> None:
    clip = tmp_path / "notes.wav"
    clip.write_bytes(b"not audio")

    response = client.post("/voice", json={"voice": str(clip)})

    assert response.status_code == 400
    assert "not a recording the engine can read" in response.json()["detail"]


def test_voice_is_unavailable_until_the_models_are_in() -> None:
    release = threading.Event()

    def slow_loader() -> Engine:
        assert release.wait(WAIT)
        return Engine(speech=FakeSpeech(), image=FakeImage())

    with TestClient(create_app(slow_loader)) as client:
        assert client.post("/voice", json={"voice": "voice.wav"}).status_code == 503
        release.set()


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
