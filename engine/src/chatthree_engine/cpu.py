"""Stop Windows slowing the engine down as a background process.

Chatterbox's sampling loop is single-threaded Python, so it is only as fast as
the core it lands on. Windows treats a windowless process as background work:
it throttles its CPU speed and, on a hybrid CPU, parks it on efficiency cores.
Measured on an i7-12700K (median synthesis time as a fraction of audio length,
three interleaved rounds): 0.54 by default, 0.42 pinned to performance cores,
0.37 with throttling switched off, 0.34 with both.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from dataclasses import dataclass

MAX_MASK_BITS = 64
# PROCESS_INFORMATION_CLASS.ProcessPowerThrottling and its structure constants.
PROCESS_POWER_THROTTLING = 4
POWER_THROTTLING_VERSION = 1
POWER_THROTTLING_EXECUTION_SPEED = 0x1


@dataclass(frozen=True)
class LogicalProcessor:
    """One logical processor: its index and Windows efficiency class (higher is faster)."""

    index: int
    efficiency_class: int


def performance_mask(processors: list[LogicalProcessor]) -> int | None:
    """Return an affinity mask of the fastest core class, or None when all cores are alike."""
    classes = {processor.efficiency_class for processor in processors}
    if len(classes) <= 1:
        return None
    fastest = max(classes)
    mask = 0
    for processor in processors:
        if processor.efficiency_class == fastest:
            mask |= 1 << processor.index
    return mask


class _CpuSetInformation(ctypes.Structure):
    """SYSTEM_CPU_SET_INFORMATION, as documented for GetSystemCpuSetInformation."""

    _fields_ = (
        ("size", wintypes.DWORD),
        ("type", wintypes.DWORD),
        ("id", wintypes.DWORD),
        ("group", wintypes.WORD),
        ("logical_processor_index", ctypes.c_ubyte),
        ("core_index", ctypes.c_ubyte),
        ("last_level_cache_index", ctypes.c_ubyte),
        ("numa_node_index", ctypes.c_ubyte),
        ("efficiency_class", ctypes.c_ubyte),
        ("all_flags", ctypes.c_ubyte),
        ("reserved", wintypes.DWORD),
        ("allocation_tag", ctypes.c_uint64),
    )


def _logical_processors() -> list[LogicalProcessor]:
    """List this machine's logical processors, or nothing if they cannot be pinned by one mask."""
    if sys.platform != "win32":
        return []
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetSystemCpuSetInformation.argtypes = (
        ctypes.c_void_p,
        wintypes.ULONG,
        ctypes.POINTER(wintypes.ULONG),
        wintypes.HANDLE,
        wintypes.ULONG,
    )
    process = kernel32.GetCurrentProcess()
    needed = wintypes.ULONG(0)
    kernel32.GetSystemCpuSetInformation(None, 0, ctypes.byref(needed), process, 0)
    buffer = ctypes.create_string_buffer(needed.value)
    if not kernel32.GetSystemCpuSetInformation(buffer, needed, ctypes.byref(needed), process, 0):
        return []
    processors: list[LogicalProcessor] = []
    offset = 0
    while offset < needed.value:
        entry = _CpuSetInformation.from_buffer(buffer, offset)
        if entry.group != 0 or entry.logical_processor_index >= MAX_MASK_BITS:
            return []  # more than one processor group: a single mask cannot describe it
        processors.append(LogicalProcessor(entry.logical_processor_index, entry.efficiency_class))
        offset += entry.size
    return processors


class _PowerThrottlingState(ctypes.Structure):
    """PROCESS_POWER_THROTTLING_STATE, as documented for SetProcessInformation."""

    _fields_ = (
        ("version", wintypes.ULONG),
        ("control_mask", wintypes.ULONG),
        ("state_mask", wintypes.ULONG),
    )


def run_at_full_speed() -> bool:
    """Opt this process out of power throttling and pin it to the fastest cores.

    Returns whether both settings are in force. On other platforms, or on a CPU
    whose cores are all alike, there is nothing to pin and this returns False.
    """
    if sys.platform != "win32":
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetProcessInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel32.SetProcessAffinityMask.argtypes = (wintypes.HANDLE, ctypes.c_size_t)
    process = kernel32.GetCurrentProcess()
    # Taking control of execution-speed throttling with the state bit clear turns it off.
    unthrottled = _PowerThrottlingState(POWER_THROTTLING_VERSION, POWER_THROTTLING_EXECUTION_SPEED, 0)
    full_speed = bool(
        kernel32.SetProcessInformation(
            process, PROCESS_POWER_THROTTLING, ctypes.byref(unthrottled), ctypes.sizeof(unthrottled)
        )
    )
    mask = performance_mask(_logical_processors())
    pinned = mask is not None and bool(kernel32.SetProcessAffinityMask(process, mask))
    return full_speed and pinned
