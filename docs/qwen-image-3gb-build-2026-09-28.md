# Qwen-Image-2.1 3GB build — 2026-09-28

The full official local source was read from:

- source: `Qwen/Qwen-Image-2.1`
- revision: `790c92633540aa0cb11d9abf19eb46d861714758`
- source directory: `.local-data/models/Qwen-Image-2.1-BF16`
- builder: `scripts/build-qwen-image-3gb.py`
- output: `.local-data/models/Qwen-Image-2.1-3GB`

The builder is CPU-only and does not import `torch` or CUDA. It reads the
safetensors header and seeks each source tensor in source chunks of at most
4 MiB. Each source tensor is emitted as its own safetensors file, so the
largest packed output tensor is bounded independently of the complete model.
The rebuild is published through a complete staging directory; the previous
live directory is retained beside it as
`.previous-20260928-173804-30964` for rollback.

## Actual audit and build

| Component | Source bytes | Tensors | Quantized 1-bit | Quantized 2-bit | Quantized 4-bit | F32 tensors | Planned bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| `text_encoder` | 17,534,247,392 | 750 | 108 | 263 | 0 | 379 | 1,662,078,336 |
| `transformer` | 14,230,249,472 | 297 | 224 | 0 | 8 | 65 | 1,051,533,312 |
| `vae` | 1,350,961,616 | 238 | 0 | 0 | 88 | 150 | 174,493,260 |
| **total** | **33,115,458,480** | **1,285** | **332** | **263** | **96** | **594** | **2,888,104,908** |

The completed output contains 1,285 safetensors files and has exactly
`2,888,533,636` weight bytes. This is below the hard limit of
`3,000,000,000` bytes by `111,466,364` bytes. Including copied configuration,
processor, scheduler, and manifest files, the complete directory is
`2,904,991,964` bytes. The largest individual packed array is `155,582,464`
bytes. The extra `428,728` bytes over the planned raw payload are safetensors
per-file headers and metadata.

The output manifest is
`.local-data/models/Qwen-Image-2.1-3GB/LOCAL_IMAGE_MODEL.json`.
It contains the original tensor name and shape map for each component, the
output file, bit width, group size, packed/scales or weight keys, and the exact
source/revision. It sets `quality_validated` to `false`.

## Runtime protocol

For every tensor, flatten in C order and split into groups of 128. Only the
last logical group is zero padded; the decoder truncates back to
`logical_elements` before reshaping.

- `bits: 1`: `packed` is `uint8`, one little-endian bit per value, with code
  `0 -> -scale` and `1 -> +scale`. `scales` is `float16` and equals the mean
  absolute value of the logical values in each group.
- `bits: 2`: `packed` is `uint8`, four little-endian 2-bit codes per byte.
  Codes `0, 1, 2, 3` decode to `-3*scale, -scale, +scale, +3*scale`;
  `scale = max(abs(logical group))/3`.
- `bits: 4`: `packed` is `uint8`, with the low and high nibbles holding two
  codes. Codes `0..15` decode to
  `-15,-13,-11,-9,-7,-5,-3,-1,+1,+3,+5,+7,+9,+11,+13,+15` times scale;
  `scale = max(abs(logical group))/15`. All VAE matrices use this width.
- DiT matrices outside `transformer_blocks.*` use 4-bit, including
  `modulation.1`, `norm_out.linear`, `proj_out`, `txt_in`, and time embedding
  matrices. Repeated block matrices remain 1-bit.
- `bits: 0`: the output uses `weight` with `float32`. This includes all
  scalar/1-D parameters and high-dimensional source entries that do not end
  in `.weight`, including VAE normalization `*.gamma` tensors and the learned
  visual `*.pos_embed.weight` table.

The selected widths retain every source tensor and layer but are an aggressive
custom low-bit representation. No quality, image-generation, or numerical
equivalence claim is made by this build. The matching local runtime must decode
this manifest before the image service can use the directory.

## End-to-end image result

The byte and tensor checks above do not establish usable image quality. Two
real local generation checks have now failed:

- The earlier v1 3GB checkpoint generated
  `f941ebf568784aa2ab03bb2e82120965.png` at 512×512. Visual inspection found
  a near-solid magenta result rather than the requested image.
- The current v2 checkpoint generated
  `6a82bdf7a8714aa6ba897f3721b2328c.png` at 512×512 in 40.375 seconds for a
  green table lamp on a white background. Visual inspection found only noisy
  texture, with no recognizable lamp or scene.

The v2 response evidence is recorded in
`artifacts/qwen-image/generation-verification-3gb-v2.json`; the earlier v1
response is recorded in `artifacts/qwen-image/generation-verification-3gb.json`.
Both versions therefore remain experimental low-bit artifacts and must not be
described as capable of normal image generation. The manifest intentionally
keeps `quality_validated: false`.

## Verification performed

The manifest and every emitted safetensors file were read with
`safetensors.numpy.load_file`. Verification confirmed:

- all 1,285 original tensor names and shapes are present;
- every quantized file has exactly `packed` (`uint8`) and `scales` (`float16`);
- every F32 fallback file has exactly `weight` (`float32`);
- the manifest byte count equals the recursive output byte count;
- 4-bit nibble decoding was checked against source samples from
  `modulation.1.weight` and `decoder.conv_in.weight`;
- the verification process had no `torch` module loaded.
