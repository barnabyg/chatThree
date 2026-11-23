"""Choosing which cores the engine is pinned to, and applying the settings."""

from chatthree_engine.cpu import LogicalProcessor, performance_mask, run_at_full_speed


def test_hybrid_cpu_is_pinned_to_its_fastest_cores() -> None:
    # Eight performance threads then four efficiency cores, as Windows reports them.
    processors = [LogicalProcessor(index, 1) for index in range(8)]
    processors += [LogicalProcessor(index, 0) for index in range(8, 12)]

    assert performance_mask(processors) == 0b0000_1111_1111


def test_fastest_cores_need_not_come_first() -> None:
    processors = [LogicalProcessor(0, 0), LogicalProcessor(1, 2), LogicalProcessor(2, 1), LogicalProcessor(3, 2)]

    assert performance_mask(processors) == 0b1010


def test_uniform_cpu_is_left_alone() -> None:
    assert performance_mask([LogicalProcessor(index, 0) for index in range(16)]) is None


def test_unknown_topology_is_left_alone() -> None:
    assert performance_mask([]) is None


def test_applying_the_settings_on_this_machine_does_not_raise() -> None:
    assert run_at_full_speed() in (True, False)
