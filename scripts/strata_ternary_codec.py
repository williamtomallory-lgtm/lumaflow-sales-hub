"""Experimental Bonsai-format / Strata-format bridge, not a trained Bonsai model.

PTQ1_0 is group-128 ternary (28 bytes); Strata Q2_0 is group-64
(18 bytes). Duplicating each scale transcodes these ternary values exactly.
Activation rotations are a separate model operation, never inferred from bytes.
Format reference: PrismML-Eng/llama.cpp, ggml-quants.c, revision
e8fd209c975c80aa7fb36a8423571ff3b1b7e955 (MIT).
"""
import numpy as np


def pack_ptq1(codes, scales):
    codes = np.asarray(codes)
    if codes.ndim != 2 or codes.shape[1] != 128 or not np.isin(codes, [-1, 0, 1]).all():
        raise ValueError("Expected N by 128 ternary codes")
    scales = np.asarray(scales, dtype="<f2").reshape(-1)
    if len(scales) != len(codes) or not np.isfinite(scales).all() or (scales < 0).any():
        raise ValueError("Expected one finite, nonnegative FP16 scale per group")
    trits = codes.astype(np.uint16) + 1
    out = np.zeros((len(codes), 28), np.uint8)
    start, column = 0, 0
    for width in (16, 8):
        digits = trits[:, start:start + 5 * width].reshape(-1, 5, width)
        q = sum(digits[:, j] * (3 ** (4 - j)) for j in range(5))
        out[:, column:column + width] = (q * 256 + 242) // 243
        start += 5 * width
        column += width
    digits = trits[:, 120:].reshape(-1, 4, 2)
    q = sum(digits[:, j] * (3 ** (4 - j)) for j in range(4))
    out[:, 24:26] = (q * 256 + 242) // 243
    out[:, 26:] = scales.view(np.uint8).reshape(-1, 2)
    return out.tobytes()


def unpack_ptq1(raw):
    if len(raw) % 28:
        raise ValueError("Truncated PTQ1_0 block")
    blocks = np.frombuffer(raw, np.uint8).reshape(-1, 28)
    parts = []
    for start, width, count in ((0, 16, 5), (16, 8, 5), (24, 2, 4)):
        q = blocks[:, start:start + width].astype(np.uint16)
        parts.append(np.stack([(((q * 3 ** j) & 255) * 3 >> 8).astype(np.int8) - 1
                               for j in range(count)], axis=1).reshape(-1, width * count))
    codes = np.concatenate(parts, axis=1)
    scales = np.ascontiguousarray(blocks[:, 26:28]).view("<f2").reshape(-1)
    if not np.isfinite(scales).all() or (scales < 0).any():
        raise ValueError("Invalid PTQ1_0 scale")
    return codes, scales


def ptq1_to_strata_q2(raw):
    """Lossless value bridge; 28 bytes become 36, without FP requantization."""
    codes, scales = unpack_ptq1(raw)
    digits = (codes.astype(np.int16) + 1).astype(np.uint8).reshape(-1, 64)
    out = np.empty((len(digits), 18), np.uint8)
    out[:, :2] = scales.repeat(2).view(np.uint8).reshape(-1, 2)
    out[:, 2:] = digits[:, 0::4] | (digits[:, 1::4] << 2) | (digits[:, 2::4] << 4) | (digits[:, 3::4] << 6)
    return out.tobytes()


def fit_ternary(values):
    """Per-group least-squares baseline, NOT Bonsai's trained weight recipe.

    Find the optimal number of nonzero values for each 128-wide group, then
    store its mean magnitude in FP16. No inference quality is implied by MSE.
    """
    values = np.asarray(values, dtype=np.float32)
    if values.size % 128 or not np.isfinite(values).all():
        raise ValueError("Expected finite, whole groups of 128 values")
    groups = values.reshape(-1, 128)
    magnitudes = np.sort(np.abs(groups), axis=1)[:, ::-1]
    sums = np.cumsum(magnitudes, axis=1, dtype=np.float64)
    counts = np.arange(1, 129)
    best = np.argmax(sums ** 2 / counts, axis=1)
    scales = (sums[np.arange(len(best)), best] / (best + 1)).astype("<f2")
    if not np.isfinite(scales).all():
        raise ValueError("FP16 scale overflow")
    codes = np.where(np.abs(groups) > scales[:, None].astype(np.float32) / 2,
                     np.sign(groups), 0).astype(np.int8)
    return pack_ptq1(codes, scales)


def hadamard(values, block=128):
    """Orthogonal block transform for probes; runtime activations need it too."""
    if block < 2 or block & (block - 1):
        raise ValueError("Hadamard block must be a power of two")
    values = np.asarray(values, np.float32)
    if values.shape[-1] % block:
        raise ValueError("Transform cannot cross matrix row boundaries")
    result = values.copy().reshape(-1, block)
    width = 1
    while width < block:
        pairs = result.reshape(-1, block // (2 * width), 2, width)
        left, right = pairs[:, :, 0].copy(), pairs[:, :, 1].copy()
        pairs[:, :, 0], pairs[:, :, 1] = left + right, left - right
        width *= 2
    return (result / np.sqrt(block)).reshape(values.shape)
