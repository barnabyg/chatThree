"""The exact model files the engine runs, pinned by repository revision.

Pinning means an upstream edit can never change behaviour or trigger a fresh
multi-gigabyte download, and a machine that already holds the files starts
without touching the network. Bump a revision deliberately, then re-run the
benchmark.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import huggingface_hub


@dataclass(frozen=True)
class ModelPin:
    """One Hugging Face repository at a fixed commit, limited to the files the engine loads."""

    repo: str
    revision: str
    files: tuple[str, ...]


CHATTERBOX = ModelPin(
    repo="ResembleAI/chatterbox",
    revision="5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
    files=("ve.safetensors", "t3_cfg.safetensors", "s3gen.safetensors", "tokenizer.json", "conds.pt"),
)
CHATTERBOX_TURBO = ModelPin(
    repo="ResembleAI/chatterbox-turbo",
    revision="749d1c1a46eb10492095d68fbcf55691ccf137cd",
    files=(
        "ve.safetensors",
        "t3_turbo_v1.safetensors",
        "s3gen_meanflow.safetensors",
        "conds.pt",
        "*.json",
        "*.txt",
        "*.model",
    ),
)
KLEIN_4B = ModelPin(
    repo="black-forest-labs/FLUX.2-klein-4B",
    revision="e7b7dc27f91deacad38e78976d1f2b499d76a294",
    files=("model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*"),
)


def fetch(pin: ModelPin) -> Path:
    """Return the local folder holding the pinned files, downloading any that are missing."""
    # huggingface_hub's download signature is only partially typed.
    hub: Any = huggingface_hub
    return Path(hub.snapshot_download(pin.repo, revision=pin.revision, allow_patterns=list(pin.files)))
