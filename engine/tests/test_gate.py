"""GpuGate behaviour, exercised with plain threads (no GPU needed)."""

from __future__ import annotations

import threading

from chatthree_engine.gate import GpuGate

WAIT = 5.0


def test_speech_and_image_never_overlap() -> None:
    gate = GpuGate()
    inside = 0
    overlaps = 0
    lock = threading.Lock()

    def enter_and_leave() -> None:
        nonlocal inside, overlaps
        with lock:
            inside += 1
            if inside > 1:
                overlaps += 1
        with lock:
            inside -= 1

    def speech_job() -> None:
        for _ in range(200):
            with gate.speech():
                enter_and_leave()

    def image_job() -> None:
        for _ in range(50):
            with gate.image():
                for _ in range(4):
                    enter_and_leave()
                    gate.checkpoint()

    threads = [threading.Thread(target=speech_job), threading.Thread(target=image_job)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(WAIT)
    assert not any(thread.is_alive() for thread in threads)
    assert overlaps == 0


def test_waiting_speech_runs_at_the_next_checkpoint() -> None:
    gate = GpuGate()
    order: list[str] = []
    image_holding = threading.Event()
    speech_queued = threading.Event()

    def image_job() -> None:
        with gate.image():
            order.append("image step 1")
            image_holding.set()
            assert speech_queued.wait(WAIT)
            # Give the speech thread time to block on the gate before yielding.
            while gate.speech_waiting == 0:
                pass
            gate.checkpoint()
            order.append("image step 2")

    def speech_job() -> None:
        assert image_holding.wait(WAIT)
        speech_queued.set()
        with gate.speech():
            order.append("speech")

    threads = [threading.Thread(target=image_job), threading.Thread(target=speech_job)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(WAIT)
    assert order == ["image step 1", "speech", "image step 2"]


def test_checkpoint_returns_immediately_when_no_speech_waits() -> None:
    gate = GpuGate()
    with gate.image():
        gate.checkpoint()
    with gate.speech():
        pass


def test_image_does_not_start_ahead_of_waiting_speech() -> None:
    gate = GpuGate()
    order: list[str] = []
    release_first = threading.Event()
    first_holding = threading.Event()

    def first_speech() -> None:
        with gate.speech():
            first_holding.set()
            assert release_first.wait(WAIT)

    def second_speech() -> None:
        with gate.speech():
            order.append("speech")

    def image_job() -> None:
        with gate.image():
            order.append("image")

    holder = threading.Thread(target=first_speech)
    holder.start()
    assert first_holding.wait(WAIT)
    image_thread = threading.Thread(target=image_job)
    image_thread.start()
    speech_thread = threading.Thread(target=second_speech)
    speech_thread.start()
    while gate.speech_waiting == 0:
        pass
    release_first.set()
    for thread in (holder, image_thread, speech_thread):
        thread.join(WAIT)
    assert order == ["speech", "image"]
