"""Image generation with optional reference images, backed by FLUX.2 klein."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import torch
from diffusers.pipelines.flux2.pipeline_flux2_klein import Flux2KleinPipeline

from chatthree_engine.models import KLEIN_4B, ModelPin, fetch

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from PIL.Image import Image

# The klein models are step-distilled: four steps, no classifier-free guidance.
DISTILLED_STEPS = 4
DISTILLED_GUIDANCE = 1.0
# The image transformer's weights rest on the GPU as 8-bit floats and are widened
# layer by layer as they run: 3.6 GB less resident memory for no measurable time
# cost. The text encoder stays at 16-bit; compacting it the same way saved a
# further 3.7 GB in testing but only by calling a private pipeline method.
STORAGE_DTYPE = torch.float8_e4m3fn
COMPUTE_DTYPE = torch.bfloat16


class ImageModel:
    """A loaded klein pipeline. References steer identity and setting.

    `compact` stores the transformer's weights as 8-bit floats (11.3 GB resident
    instead of 14.9 GB); turn it off only to compare output against full precision.
    """

    def __init__(self, pin: ModelPin = KLEIN_4B, device: str = "cuda", *, compact: bool = True) -> None:
        self._device = device
        # diffusers publishes no usable type information, so the pipeline is opaque here.
        loader: Any = Flux2KleinPipeline
        self._pipeline: Any = loader.from_pretrained(fetch(pin), torch_dtype=COMPUTE_DTYPE).to(device)
        if compact:
            self._pipeline.transformer.enable_layerwise_casting(
                storage_dtype=STORAGE_DTYPE, compute_dtype=COMPUTE_DTYPE
            )
            torch.cuda.empty_cache()  # release the 16-bit copies' memory straight away

    def generate(
        self,
        prompt: str,
        references: Sequence[Image] = (),
        *,
        size: tuple[int, int] = (1024, 1024),
        seed: int = 0,
        on_step: Callable[[], None] | None = None,
    ) -> Image:
        """Generate one `size` (width, height) image.

        `on_step` runs after every denoising step, once that step's GPU work has
        actually finished, so a caller can hand the GPU to another job there.
        """

        def after_step(
            _pipeline: object, _step: int, _timestep: object, tensors: dict[str, object]
        ) -> dict[str, object]:
            if on_step is not None:
                # GPU work is queued asynchronously: without this wait the callback
                # fires while the step is still pending and nothing can cut in.
                torch.cuda.synchronize()
                on_step()
            return tensors

        result = self._pipeline(
            image=list(references) or None,
            prompt=prompt,
            width=size[0],
            height=size[1],
            num_inference_steps=DISTILLED_STEPS,
            guidance_scale=DISTILLED_GUIDANCE,
            generator=torch.Generator(self._device).manual_seed(seed),
            callback_on_step_end=after_step,
        )
        image: Image = result.images[0]
        # Hand the job's working memory back to the driver. Left cached, it
        # fragments against the speech model's allocations and the process creeps
        # to the card's limit, where Windows spills into slow shared memory.
        torch.cuda.empty_cache()
        return image
